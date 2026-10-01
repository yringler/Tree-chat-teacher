// The credit ledger (PLAN §2.5). Every write is a single idempotent statement,
// so there is no cross-table atomicity to get wrong:
//
//   balance = Σ credit_grants.amount_micros − Σ settled usage_events.charge_micros
//   held    = Σ pending usage_events.hold_micros

export type CreditGrantKind = 'purchase' | 'subscription' | 'refund' | 'adjustment';

export interface CreditGrantInput {
  accountId: string;
  kind: CreditGrantKind;
  /** Signed micro-USD (refunds are negative). */
  amountMicros: number;
  /** Stripe object id for idempotency; null for manual adjustments. */
  stripeRef: string | null;
  note?: string;
}

const BALANCE_SQL = `SELECT
  (SELECT COALESCE(SUM(amount_micros), 0) FROM credit_grants WHERE account_id = ?1)
  - (SELECT COALESCE(SUM(charge_micros), 0) FROM usage_events WHERE account_id = ?1 AND status = 'settled') AS balance,
  (SELECT COALESCE(SUM(hold_micros), 0) FROM usage_events WHERE account_id = ?1 AND status = 'pending') AS held`;

export async function getBalance(
  db: D1Database,
  accountId: string,
): Promise<{ balanceMicros: number; heldMicros: number }> {
  const row = await db
    .prepare(BALANCE_SQL)
    .bind(accountId)
    .first<{ balance: number; held: number }>();
  return { balanceMicros: Number(row?.balance ?? 0), heldMicros: Number(row?.held ?? 0) };
}

/** Inserts a grant; resolves false when `stripeRef` was already granted (duplicate delivery). */
export async function grantCredit(db: D1Database, g: CreditGrantInput): Promise<boolean> {
  if (!Number.isSafeInteger(g.amountMicros))
    throw new Error('grantCredit: amountMicros must be an integer');
  const result = await db
    .prepare(
      `INSERT INTO credit_grants (id, account_id, kind, amount_micros, stripe_ref, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stripe_ref) DO NOTHING`,
    )
    .bind(
      crypto.randomUUID(),
      g.accountId,
      g.kind,
      g.amountMicros,
      g.stripeRef,
      g.note ?? null,
      new Date().toISOString(),
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}
