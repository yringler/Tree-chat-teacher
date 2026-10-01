// Wave 1 stub (foundation). Implemented in wave 2 by the `billing` agent.
//
// Balance = Σ credit_grants.amount_micros − Σ settled usage_events.charge_micros;
// held = Σ pending usage_events.hold_micros (PLAN §2.5).

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

export function getBalance(
  _db: D1Database,
  _accountId: string,
): Promise<{ balanceMicros: number; heldMicros: number }> {
  throw new Error('not implemented');
}

/** Inserts a grant; resolves false when `stripeRef` was already granted (duplicate delivery). */
export function grantCredit(_db: D1Database, _g: CreditGrantInput): Promise<boolean> {
  throw new Error('not implemented');
}
