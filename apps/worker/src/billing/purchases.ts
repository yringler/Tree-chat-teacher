// The purchase interface (docs/pool/PLAN.md §S5): how credit is bought and,
// once paid, what it credits. Two targets share it:
//
// - `personal`: the buyer's own ledger (`u_<userId>`), credited the pre-tax
//   amount net of Stripe's actual processing fee, spent with the usage-time
//   markup (MARKUP_BPS), as before the pool;
// - `pool`: the community pool, credited `gross / (1 + POOL_MARGIN_BPS)`. The
//   margin is taken at purchase and covers Stripe's fee, which is recorded
//   but not deducted (deviation D3: the margin applies to the pool only).
//
// Stripe is the one `PurchaseProvider` (checkout); its webhook
// (billing/webhook.ts), the admin's simulated purchases and nothing else call
// `fulfilPurchase`, the only place purchase credit is computed. Every grant
// is idempotent on its `ref` (a Stripe Checkout Session id, or `dev:<key>`).
import { DomainError, ValidationError } from '@tangent/core';
import { MAX_TOP_UP_CENTS, type CheckoutResponse, type PurchaseTarget } from '@tangent/shared';
import { billingAccountIdFor } from '../auth/account.js';
import { appConfig } from '../config.js';
import type { AccountContext, AppEnv } from '../env.js';
import { poolCreditMicros } from '../pool/pricing.js';
import { poolAvailable } from '../services.js';
import { grantCredit } from './ledger.js';
import { centsToMicros } from './pricing.js';
import { createCreditCheckout } from './service.js';

export type { PurchaseTarget };

export interface CheckoutRequestInput {
  target: PurchaseTarget;
  amountCents: number;
  user: { id: string; email: string; name: string };
  /** The buyer's account (the app the checkout returns to, and their personal ledger). */
  account: AccountContext;
  baseUrl: string;
}

/** Sells credit: opens a hosted checkout for one purchase. */
export interface PurchaseProvider {
  createCheckout(input: CheckoutRequestInput): Promise<CheckoutResponse>;
}

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
  /** Idempotency key: the Checkout Session id, or `dev:<key>` for a simulated purchase. */
  ref: string;
  note?: string;
}

/** The personal grant amounts for a pre-tax `subtotalCents` paid with `feeCents` of processing fees. */
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

/** The pool grant amounts for a pre-tax `grossCents` at `marginBps`; the fee is recorded only. */
export function poolPurchaseAmounts(
  grossCents: number,
  feeCents: number,
  marginBps: number,
): { amountMicros: number; grossMicros: number; feeMicros: number; marginBps: number } {
  const grossMicros = centsToMicros(grossCents);
  return {
    amountMicros: poolCreditMicros(grossMicros, marginBps),
    grossMicros,
    feeMicros: centsToMicros(Math.max(0, feeCents)),
    marginBps,
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
      ...poolPurchaseAmounts(p.grossCents, p.processorFeeCents, config.pool.marginBps),
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
 * and a pool purchase at least POOL_MIN_PURCHASE_CENTS (so the margin covers
 * Stripe's fee). Personal bounds are checked by the checkout itself.
 */
export function assertPurchasable(env: AppEnv, target: PurchaseTarget, amountCents: number): void {
  if (target !== 'pool') return;
  if (!poolAvailable(env))
    throw new DomainError('bad_request', 'The community pool is not available');
  const min = appConfig(env).pool.minPurchaseCents;
  if (!Number.isInteger(amountCents) || amountCents < min || amountCents > MAX_TOP_UP_CENTS)
    throw new ValidationError(
      `amountCents must be a whole number from ${min} to ${MAX_TOP_UP_CENTS} for the community pool`,
    );
}

/** Stripe Checkout as the `PurchaseProvider` (billing/service.ts `createCreditCheckout`). */
export function stripePurchases(env: AppEnv): PurchaseProvider {
  return {
    async createCheckout(input) {
      assertPurchasable(env, input.target, input.amountCents);
      return createCreditCheckout(
        env,
        input.account,
        input.user,
        input.amountCents,
        input.baseUrl,
        input.target,
      );
    },
  };
}
