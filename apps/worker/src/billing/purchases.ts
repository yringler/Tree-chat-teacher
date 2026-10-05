// The purchase interface (docs/pool/PLAN.md §S5): how credit is bought and,
// once paid, what it credits. Two targets share it:
//
// - `personal`: the buyer's own ledger (`u_<userId>`), spent with the
//   usage-time markup (MARKUP_BPS);
// - `pool`: the community pool, spent with the pool's usage-time markup
//   (POOL_MARKUP_BPS).
//
// Both are credited the same way: the pre-tax amount paid net of the payment
// provider's actual processing fee (`netOfFee`). The operator earns on usage,
// never on the purchase (docs/polar-migration/04-verification.md, D4).
//
// Checkouts go through the payment provider's port (billing/service.ts
// `startTopUpCheckout`). The payment webhook (billing/payments/apply.ts), the
// admin's simulated purchases and nothing else call `fulfilPurchase`, the
// only place purchase credit is computed. Every grant is idempotent on its
// `ref` (a provider's payment ref such as `polar:order:<id>`, or `dev:<key>`).
import { DomainError, ValidationError } from '@tangent/core';
import { MAX_TOP_UP_CENTS, type PurchaseTarget } from '@tangent/shared';
import { billingAccountIdFor } from '../auth/account.js';
import { appConfig } from '../config.js';
import type { AppEnv } from '../env.js';
import { poolAvailable } from '../services.js';
import { grantCredit } from './ledger.js';
import { centsToMicros } from './pricing.js';

export type { PurchaseTarget };

/** A purchase the processor reports as paid. */
export interface PaidPurchase {
  target: PurchaseTarget;
  /** The buyer; null only for personal purchases from before checkouts recorded it. */
  userId: string | null;
  /**
   * The ledger credited, as the checkout recorded it. Default: the buyer's
   * personal ledger, or the pool's account id (`POOL_ACCOUNT_ID`).
   */
  accountId?: string | null;
  /** Pre-tax amount paid, in cents (tax is never credited). */
  grossCents: number;
  /** The processor's fee on the payment, in cents. */
  processorFeeCents: number;
  /** Idempotency key: the provider's payment ref (`polar:order:<id>`), or `dev:<key>` for a simulated purchase. */
  ref: string;
  note?: string;
}

/** The grant amounts (personal or pool) for a pre-tax `subtotalCents` paid with `feeCents` of processing fees. */
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
 * computed; both targets record the buyer (`user_id`).
 */
export async function fulfilPurchase(env: AppEnv, p: PaidPurchase): Promise<boolean> {
  if (!Number.isSafeInteger(p.grossCents) || p.grossCents <= 0)
    throw new Error(`fulfilPurchase: no amount paid for ${p.ref}`);
  if (p.target === 'pool') {
    const config = appConfig(env);
    return grantCredit(env.DB, {
      accountId: p.accountId || config.pool.accountId,
      kind: 'purchase',
      ...netOfFee(p.grossCents, p.processorFeeCents),
      userId: p.userId,
      providerRef: p.ref,
      note: p.note ?? 'Community pool purchase',
    });
  }
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

/**
 * Throws unless `target` may be bought for `amountCents`: the pool must be on,
 * pool purchases open (`POOL_PURCHASES_ENABLED`, D1), and a pool purchase at
 * least POOL_MIN_PURCHASE_CENTS. Personal bounds are checked by the checkout itself.
 */
export function assertPurchasable(env: AppEnv, target: PurchaseTarget, amountCents: number): void {
  if (target !== 'pool') return;
  if (!poolAvailable(env))
    throw new DomainError('bad_request', 'The community pool is not available');
  if (!appConfig(env).flags.poolPurchasesEnabled)
    throw new DomainError('bad_request', 'Funding the community pool is not open yet');
  const min = appConfig(env).pool.minPurchaseCents;
  if (!Number.isInteger(amountCents) || amountCents < min || amountCents > MAX_TOP_UP_CENTS)
    throw new ValidationError(
      `amountCents must be a whole number from ${min} to ${MAX_TOP_UP_CENTS} for the community pool`,
    );
}
