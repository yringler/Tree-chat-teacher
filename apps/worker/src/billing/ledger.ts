// The credit ledger (PLAN §2.5). Every write is a single idempotent statement,
// so there is no cross-table atomicity to get wrong:
//
//   balance = Σ credit_grants.amount_micros − Σ settled usage_events.charge_micros
//   held    = Σ pending usage_events.hold_micros
//   pending = number of pending usage_events (metered calls in flight)
//
// The open pool is one more account in the same tables (pool/pool-bank.ts).

/**
 * - `purchase`: credit bought (net of the processing fee); `refund`: a refund
 *   or dispute taking credit back; `adjustment`: an admin's (or a marker row).
 */
export type CreditGrantKind = 'purchase' | 'refund' | 'adjustment';

export interface CreditGrantInput {
  accountId: string;
  kind: CreditGrantKind;
  /** Signed micro-USD (refunds are negative); for purchases, net of the processing fee. */
  amountMicros: number;
  /**
   * Purchases: the pre-tax amount paid, before the processing fee. Refunds: minus the refunded
   * pre-tax amount.
   */
  grossMicros?: number | null;
  /** Purchases: the payment provider's actual processing fee (`grossMicros - amountMicros` for personal credit). */
  feeMicros?: number;
  /** The buyer or beneficiary. */
  userId?: string | null;
  /**
   * Idempotency key: a payment, refund or dispute ref such as
   * `polar:order:<id>`, or a ref the domain derives from one (`…:reinstated`,
   * `…:lost`, `…:ignored`); `admin:<key>` for an admin's
   * adjustment, `dev:<key>` for a simulated purchase (provider refs never start
   * with those); null for SQL adjustments.
   */
  providerRef: string | null;
  /** Refunds, disputes and reinstatements: the payment they take back from. */
  paymentRef?: string | null;
  note?: string;
}

/**
 * A ledger sum up to `at` (ISO): Σ grants − Σ charges of the rows created
 * before it. Those rows never change once they have left `pending`, so the
 * sum never goes stale, and a balance is the checkpoint plus the rows since.
 * Only valid while no row created before `at` is still pending.
 */
export interface BalanceCheckpoint {
  balanceMicros: number;
  at: string;
}

const BALANCE_SQL = `SELECT
  (SELECT COALESCE(SUM(amount_micros), 0) FROM credit_grants WHERE account_id = ?1)
  - (SELECT COALESCE(SUM(charge_micros), 0) FROM usage_events WHERE account_id = ?1 AND status = 'settled') AS balance,
  (SELECT COALESCE(SUM(hold_micros), 0) FROM usage_events WHERE account_id = ?1 AND status = 'pending') AS held,
  (SELECT COUNT(*) FROM usage_events WHERE account_id = ?1 AND status = 'pending') AS pending`;

const BALANCE_SINCE_SQL = `SELECT
  ?2 + (SELECT COALESCE(SUM(amount_micros), 0) FROM credit_grants WHERE account_id = ?1 AND created_at >= ?3)
  - (SELECT COALESCE(SUM(charge_micros), 0) FROM usage_events
     WHERE account_id = ?1 AND status <> 'pending' AND created_at >= ?3) AS balance,
  (SELECT COALESCE(SUM(hold_micros), 0) FROM usage_events WHERE account_id = ?1 AND status = 'pending') AS held,
  (SELECT COUNT(*) FROM usage_events WHERE account_id = ?1 AND status = 'pending') AS pending`;

export interface BalanceRow {
  balance: number;
  held: number;
  pending: number;
}

/** The balance query, for callers that batch it with others (`getBalance` runs it alone). */
export function balanceStatement(
  db: D1Database,
  accountId: string,
  checkpoint?: BalanceCheckpoint | null,
): D1PreparedStatement {
  return checkpoint
    ? db.prepare(BALANCE_SINCE_SQL).bind(accountId, checkpoint.balanceMicros, checkpoint.at)
    : db.prepare(BALANCE_SQL).bind(accountId);
}

export function readBalance(row: BalanceRow | null | undefined): {
  balanceMicros: number;
  heldMicros: number;
  pendingCalls: number;
} {
  return {
    balanceMicros: Number(row?.balance ?? 0),
    heldMicros: Number(row?.held ?? 0),
    pendingCalls: Number(row?.pending ?? 0),
  };
}

/**
 * With `checkpoint`, sums only the rows since it (the pool's hot path); the
 * result is the same. The full sum subtracts `settled` charges and the
 * checkpointed one every non-pending row's: the only other status,
 * `unresolved`, is always charged 0 (`markUnresolved`), and no statement
 * changes a row once it has left `pending`.
 */
export async function getBalance(
  db: D1Database,
  accountId: string,
  checkpoint?: BalanceCheckpoint | null,
): Promise<{ balanceMicros: number; heldMicros: number; pendingCalls: number }> {
  return readBalance(await balanceStatement(db, accountId, checkpoint).first<BalanceRow>());
}

/** Inserts a grant; resolves false when `providerRef` was already granted (duplicate delivery). */
export async function grantCredit(db: D1Database, g: CreditGrantInput): Promise<boolean> {
  if (!Number.isSafeInteger(g.amountMicros))
    throw new Error('grantCredit: amountMicros must be an integer');
  const gross = g.grossMicros ?? null;
  const fee = g.feeMicros ?? 0;
  if ((gross !== null && !Number.isSafeInteger(gross)) || !Number.isSafeInteger(fee))
    throw new Error('grantCredit: grossMicros and feeMicros must be integers');
  const result = await db
    .prepare(
      `INSERT INTO credit_grants
         (id, account_id, kind, amount_micros, gross_micros, fee_micros, user_id, provider_ref, payment_ref, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_ref) DO NOTHING`,
    )
    .bind(
      crypto.randomUUID(),
      g.accountId,
      g.kind,
      g.amountMicros,
      gross,
      fee,
      g.userId ?? null,
      g.providerRef,
      g.paymentRef ?? null,
      g.note ?? null,
      new Date().toISOString(),
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Inserts a `refund` row of the payment `paymentRef` on `accountId` (a refund
 * or dispute of a personal purchase, or a won dispute's reinstatement) so
 * that all of that payment's rows there together take back
 * `min(capMicros, what they ask)`. Each row's gross is what it asks: minus
 * the refunded or disputed pre-tax amount, or, for a reinstatement, plus
 * what its dispute asked. Its amount is what moves the payment's net
 * clawback to that target: a debit never adds credit and a reinstatement
 * never takes any. One statement, so concurrent writers for one payment
 * can't both take the remainder. Resolves false when `providerRef` was
 * already written.
 */
export async function grantTowardCap(
  db: D1Database,
  g: {
    accountId: string;
    grossMicros: number;
    capMicros: number;
    paymentRef: string;
    userId: string | null;
    providerRef: string;
    note: string;
  },
): Promise<boolean> {
  if (!Number.isSafeInteger(g.grossMicros) || !Number.isSafeInteger(g.capMicros))
    throw new Error('grantTowardCap: grossMicros and capMicros must be integers');
  const result = await db
    .prepare(
      `INSERT INTO credit_grants
         (id, account_id, kind, amount_micros, gross_micros, fee_micros, user_id, provider_ref, payment_ref, note, created_at)
       SELECT ?1, ?2, 'refund',
              CASE WHEN ?3 < 0 THEN MIN(0, t.amount) ELSE MAX(0, t.amount) END,
              ?3, 0, ?4, ?5, ?6, ?7, ?8
       FROM (SELECT -MIN(?9, MAX(0, -(COALESCE(SUM(gross_micros), 0) + ?3)))
                    - COALESCE(SUM(amount_micros), 0) AS amount
             FROM credit_grants WHERE account_id = ?2 AND payment_ref = ?6) AS t
       WHERE true
       ON CONFLICT(provider_ref) DO NOTHING`,
    )
    .bind(
      crypto.randomUUID(),
      g.accountId,
      g.grossMicros,
      g.userId,
      g.providerRef,
      g.paymentRef,
      g.note,
      new Date().toISOString(),
      g.capMicros,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** True when a grant for this payment object already exists (a redelivered event). */
export async function hasGrant(db: D1Database, providerRef: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS one FROM credit_grants WHERE provider_ref = ? LIMIT 1')
    .bind(providerRef)
    .first<{ one: number }>();
  return row !== null;
}

/** A grant as `grantByRef` reads it. */
export interface GrantRow {
  account_id: string;
  kind: CreditGrantKind;
  amount_micros: number;
  gross_micros: number | null;
  user_id: string | null;
}

/** The grant written for `providerRef` (a payment object ref, or `admin:` / `dev:` key), if any. */
export async function grantByRef(db: D1Database, providerRef: string): Promise<GrantRow | null> {
  return db
    .prepare(
      `SELECT account_id, kind, amount_micros, gross_micros, user_id
       FROM credit_grants WHERE provider_ref = ? LIMIT 1`,
    )
    .bind(providerRef)
    .first<GrantRow>();
}
