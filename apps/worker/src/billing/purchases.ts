// The purchase interface: how credit is bought and,
// once paid, what it credits. Credit is bought only for the buyer's own
// ledger (`u_<userId>`) and spent at the models' listed prices.
// Nobody buys credit for the open pool: Tangent funds it with admin
// adjustments, so every sale is the buyer's own usage, never a donation or
// community access (which the payment provider's policy prohibits).
//
// A purchase of N cents of credit costs N plus the service fee
// (`serviceFeeCents`), before tax, and credits exactly N. The service fee is
// Tangent's margin and pays OpenRouter's and the payment processor's fees.
//
// Checkouts go through the payment provider's port (billing/service.ts
// `startTopUpCheckout`). The payment webhook (billing/payments/apply.ts), the
// admin's simulated purchases and nothing else call `fulfilPurchase`, the
// only place purchase credit is granted. Every grant is idempotent on its
// `ref` (a provider's payment ref such as `polar:order:<id>`, or `dev:<key>`).
import { centsToMicros } from '@tangent/shared';
import { billingAccountIdFor } from '../auth/account.js';
import type { AppEnv } from '../env.js';
import { grantCredit } from './ledger.js';

/** A purchase the processor reports as paid. */
export interface PaidPurchase {
  /** The buyer, whose own ledger (`u_<userId>`) is credited. */
  userId: string;
  /** Pre-tax amount paid, in cents (tax is never credited). */
  paidCents: number;
  /** The credit bought, in cents, as the checkout recorded it. */
  creditCents: number;
  /** Idempotency key: the provider's payment ref (`polar:order:<id>`), or `dev:<key>` for a simulated purchase. */
  ref: string;
  note?: string;
}

/**
 * Credits a paid purchase, once per `ref`: resolves false when it was
 * already credited (a redelivery). The only place purchase credit is
 * computed; the grant records the buyer (`user_id`).
 */
export async function fulfilPurchase(env: AppEnv, p: PaidPurchase): Promise<boolean> {
  if (!Number.isSafeInteger(p.paidCents) || p.paidCents <= 0)
    throw new Error(`fulfilPurchase: no amount paid for ${p.ref}`);
  if (!Number.isSafeInteger(p.creditCents) || p.creditCents <= 0)
    throw new Error(`fulfilPurchase: no credit bought for ${p.ref}`);
  // A discount comes off the service fee first; it never credits more than was paid.
  const credit = Math.min(p.creditCents, p.paidCents);
  return grantCredit(env.DB, {
    accountId: billingAccountIdFor(p.userId),
    kind: 'purchase',
    amountMicros: centsToMicros(credit),
    grossMicros: centsToMicros(p.paidCents),
    feeMicros: centsToMicros(p.paidCents - credit),
    userId: p.userId,
    providerRef: p.ref,
    note: p.note ?? 'Credit top-up',
  });
}
