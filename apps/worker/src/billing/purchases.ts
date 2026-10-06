// The purchase interface (docs/pool/PLAN.md §S5): how credit is bought and,
// once paid, what it credits. Credit is bought only for the buyer's own
// ledger (`u_<userId>`), spent with the usage-time markup (MARKUP_BPS).
// Nobody buys credit for the open pool: Tangent funds it from its own
// revenue (docs/polar-migration/05-pool-framing.md).
//
// A purchase is credited the pre-tax amount paid net of the payment
// provider's actual processing fee (`netOfFee`). The operator earns on usage,
// never on the purchase (docs/polar-migration/04-verification.md, D4).
//
// Checkouts go through the payment provider's port (billing/service.ts
// `startTopUpCheckout`). The payment webhook (billing/payments/apply.ts), the
// admin's simulated purchases and nothing else call `fulfilPurchase`, the
// only place purchase credit is computed. Every grant is idempotent on its
// `ref` (a provider's payment ref such as `polar:order:<id>`, or `dev:<key>`).
import { billingAccountIdFor } from '../auth/account.js';
import type { AppEnv } from '../env.js';
import { grantCredit } from './ledger.js';
import { centsToMicros } from './pricing.js';

/** A purchase the processor reports as paid. */
export interface PaidPurchase {
  /** The buyer; null only for the dev bypass ledger (`default_simple`). */
  userId: string | null;
  /** The ledger credited, as the checkout recorded it. Default: the buyer's own ledger. */
  accountId?: string | null;
  /** Pre-tax amount paid, in cents (tax is never credited). */
  grossCents: number;
  /** The processor's fee on the payment, in cents. */
  processorFeeCents: number;
  /** Idempotency key: the provider's payment ref (`polar:order:<id>`), or `dev:<key>` for a simulated purchase. */
  ref: string;
  note?: string;
}

/** The grant amounts for a pre-tax `subtotalCents` paid with `feeCents` of processing fees. */
export function netOfFee(
  subtotalCents: number,
  feeCents: number,
): { amountMicros: number; grossMicros: number; feeMicros: number } {
  // The fee is charged on the tax-inclusive total, so it can (in theory) exceed the subtotal.
  const fee = Math.min(feeCents, subtotalCents);
  return {
    amountMicros: centsToMicros(subtotalCents - fee),
    grossMicros: centsToMicros(subtotalCents),
    feeMicros: centsToMicros(fee),
  };
}

/**
 * Credits a paid purchase, once per `ref`: resolves false when it was
 * already credited (a redelivery). The only place purchase credit is
 * computed; the grant records the buyer (`user_id`).
 */
export async function fulfilPurchase(env: AppEnv, p: PaidPurchase): Promise<boolean> {
  if (!Number.isSafeInteger(p.grossCents) || p.grossCents <= 0)
    throw new Error(`fulfilPurchase: no amount paid for ${p.ref}`);
  const accountId = p.accountId || (p.userId ? billingAccountIdFor(p.userId) : null);
  if (!accountId) throw new Error(`fulfilPurchase: no account for ${p.ref}`);
  return grantCredit(env.DB, {
    accountId,
    kind: 'purchase',
    ...netOfFee(p.grossCents, p.processorFeeCents),
    userId: p.userId,
    providerRef: p.ref,
    note: p.note ?? 'Credit top-up',
  });
}
