// The credit ledger (PLAN §2.5). Every write is a single idempotent statement,
// so there is no cross-table atomicity to get wrong:
//
//   balance = Σ credit_grants.amount_micros − Σ settled usage_events.charge_micros
//   held    = Σ pending usage_events.hold_micros
//   pending = number of pending usage_events (metered calls in flight)
//
// The community pool is one more account in the same tables (pool/pool-bank.ts).

export type CreditGrantKind = 'purchase' | 'subscription' | 'refund' | 'adjustment';

export interface CreditGrantInput {
  accountId: string;
  kind: CreditGrantKind;
  /** Signed micro-USD (refunds are negative); for purchases, net of the processing fee (or of the pool margin). */
  amountMicros: number;
  /** Purchases: the pre-tax amount paid, before Stripe's fee. Refunds: minus the refunded pre-tax amount. */
  grossMicros?: number | null;
  /** Purchases: Stripe's actual processing fee (`grossMicros - amountMicros` for personal credit). */
  feeMicros?: number;
  /** Pool purchases: the margin applied, in bps. */
  marginBps?: number;
  /** The buyer or beneficiary. */
  userId?: string | null;
  /** Stripe object id for idempotency; null for manual adjustments. */
  stripeRef: string | null;
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

/** With `checkpoint`, sums only the rows since it (the pool's hot path); the result is the same. */
export async function getBalance(
  db: D1Database,
  accountId: string,
  checkpoint?: BalanceCheckpoint | null,
): Promise<{ balanceMicros: number; heldMicros: number; pendingCalls: number }> {
  return readBalance(await balanceStatement(db, accountId, checkpoint).first<BalanceRow>());
}

/** Inserts a grant; resolves false when `stripeRef` was already granted (duplicate delivery). */
export async function grantCredit(db: D1Database, g: CreditGrantInput): Promise<boolean> {
  if (!Number.isSafeInteger(g.amountMicros))
    throw new Error('grantCredit: amountMicros must be an integer');
  const gross = g.grossMicros ?? null;
  const fee = g.feeMicros ?? 0;
  if ((gross !== null && !Number.isSafeInteger(gross)) || !Number.isSafeInteger(fee))
    throw new Error('grantCredit: grossMicros and feeMicros must be integers');
  const marginBps = g.marginBps ?? 0;
  if (!Number.isSafeInteger(marginBps))
    throw new Error('grantCredit: marginBps must be an integer');
  const result = await db
    .prepare(
      `INSERT INTO credit_grants
         (id, account_id, kind, amount_micros, gross_micros, fee_micros, margin_bps, user_id, stripe_ref, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stripe_ref) DO NOTHING`,
    )
    .bind(
      crypto.randomUUID(),
      g.accountId,
      g.kind,
      g.amountMicros,
      gross,
      fee,
      marginBps,
      g.userId ?? null,
      g.stripeRef,
      g.note ?? null,
      new Date().toISOString(),
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** True when a grant for this Stripe object already exists (a redelivered event). */
export async function hasGrant(db: D1Database, stripeRef: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS one FROM credit_grants WHERE stripe_ref = ? LIMIT 1')
    .bind(stripeRef)
    .first<{ one: number }>();
  return row !== null;
}
