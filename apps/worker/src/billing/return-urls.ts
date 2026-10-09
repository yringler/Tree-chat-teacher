// Where the payment provider sends the user back to: a leaf, shared by the
// top-up checkout (service.ts) and the membership's checkout and portal
// (membership.ts).
import type { AccountContext } from '../env.js';

/**
 * The page the payment provider's checkout returns to: the billing page of
 * the app the checkout started from (`/billing` in power, `/learn/billing` in
 * Learn).
 */
export function checkoutReturnUrl(
  baseUrl: string,
  account: AccountContext,
  outcome: 'success' | 'cancel',
): string {
  return `${billingPageUrl(baseUrl, account)}?checkout=${outcome}`;
}

/** The billing page of the app `account` is in, where the billing portal returns to. */
export function billingPageUrl(baseUrl: string, account: AccountContext): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${account.mode === 'simple' ? '/learn/billing' : '/billing'}`;
}
