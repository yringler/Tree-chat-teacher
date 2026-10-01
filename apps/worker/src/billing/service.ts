// Wave 1 stub (foundation). Implemented in wave 2 by the `billing` agent.
import type { BillingSummary, CheckoutResponse, UsageListResponse } from '@tangent/shared';
import type { AccountContext, AppEnv } from '../env.js';

/** Markup in bps: MARKUP_MONTHLY_BPS with an active subscription, else MARKUP_PREPAID_BPS. */
export function markupFor(_env: AppEnv, _account: AccountContext): Promise<number> {
  throw new Error('not implemented');
}

/**
 * Throws `PaymentRequiredError` (402) when a simple account can't start a
 * metered call. Always a no-op for power accounts.
 */
export async function assertCanSpend(_env: AppEnv, account: AccountContext): Promise<void> {
  if (account.mode === 'power') return;
  throw new Error('not implemented');
}

export function getBillingSummary(_env: AppEnv, _account: AccountContext): Promise<BillingSummary> {
  throw new Error('not implemented');
}

/** Newest first; `cursor` is the previous page's `nextCursor`. */
export function listUsage(
  _env: AppEnv,
  _account: AccountContext,
  _cursor: string | null,
  _limit: number,
): Promise<UsageListResponse> {
  throw new Error('not implemented');
}

/** Creates a Stripe Checkout Session (mode `payment`) for a credit top-up. */
export function createCreditCheckout(
  _env: AppEnv,
  _account: AccountContext,
  _user: { id: string; email: string; name: string },
  _amountCents: number,
  _baseUrl: string,
): Promise<CheckoutResponse> {
  throw new Error('not implemented');
}
