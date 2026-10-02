import { DomainError, ValidationError } from '@tangent/core';
import { deleteAccountRequestSchema } from '@tangent/shared';
import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import Stripe from 'stripe';
import { accountIdForUser, billingConfigured, getStripe } from '../billing/stripe.js';
import { sameOriginOnly } from '../byok/guard.js';
import { clearKeyCookie } from '../byok/keys.js';
import type { AppBindings, AppContext, AppEnv } from '../env.js';
import { validateJson } from '../http/errors.js';
import { purgeShare } from '../share/cache.js';
import { POWER_ACCOUNT_PREFIX } from './account.js';

/**
 * Better Auth's cookies (`cookiePrefix: 'tangent'` in auth/auth.ts), plain on
 * http://localhost and `__Secure-` prefixed on https. Cleared on deletion so
 * the browser doesn't keep presenting a session that no longer exists.
 */
const AUTH_COOKIES = ['session_token', 'session_data', 'dont_remember'].map((n) => `tangent.${n}`);

/** What deleting a user removed, for the caller (and tests). */
export interface DeletedUser {
  accountIds: string[];
  shareTokens: string[];
  stripeCustomerDeleted: boolean;
}

/**
 * Permanently deletes a Better Auth user and everything they own, in this order:
 *
 * 1. Their Stripe customer, if any. Stripe cancels every subscription of a
 *    deleted customer at once, so no membership keeps charging a user who
 *    no longer exists. A failure here aborts the whole deletion: better a
 *    retry than a subscription with nobody behind it.
 * 2. In one D1 batch (a transaction): both accounts' trees (branches, nodes,
 *    summaries and shares with their snapshots go by ON DELETE CASCADE),
 *    any share or setting left over, their subscription rows, the account
 *    rows, and the auth user (sessions, linked OAuth identities and passkeys
 *    cascade).
 * 3. Best-effort purge of their share links from this colo's edge cache.
 *    Other colos hold a copy for at most the share cache TTL; the D1 rows
 *    are gone, so nothing new is ever served.
 *
 * Kept on purpose: the billing ledger (`credit_grants`, `usage_events`),
 * which holds amounts, model names and token counts but no message content.
 * Tax and accounting law require keeping payment records, and once the
 * user row is gone the `u_<userId>` id leads nowhere. The privacy policy
 * (http/legal.ts) says so.
 */
export async function deleteUser(env: AppEnv, userId: string): Promise<DeletedUser> {
  const accountIds = [POWER_ACCOUNT_PREFIX + userId, accountIdForUser(userId)];

  const user = await env.DB.prepare('SELECT stripe_customer_id FROM auth_users WHERE id = ?1')
    .bind(userId)
    .first<{ stripe_customer_id: string | null }>();
  if (!user) throw new DomainError('not_found', 'Account not found');

  const stripeCustomerDeleted = await deleteStripeCustomer(env, user.stripe_customer_id);

  const shares = await env.DB.prepare(
    'SELECT token, version FROM shares WHERE account_id IN (?1, ?2)',
  )
    .bind(...accountIds)
    .all<{ token: string; version: number }>();

  const [p, u] = accountIds;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM trees WHERE account_id IN (?1, ?2)').bind(p, u),
    env.DB.prepare('DELETE FROM shares WHERE account_id IN (?1, ?2)').bind(p, u),
    env.DB.prepare('DELETE FROM account_settings WHERE account_id IN (?1, ?2)').bind(p, u),
    env.DB.prepare('DELETE FROM auth_subscriptions WHERE reference_id = ?1').bind(userId),
    env.DB.prepare('DELETE FROM accounts WHERE user_id = ?1 OR id IN (?2, ?3)').bind(userId, p, u),
    env.DB.prepare('DELETE FROM auth_users WHERE id = ?1').bind(userId),
  ]);

  // Only the current version can still be cached: a republish purges the one before it.
  await Promise.all(shares.results.map((s) => purgeShare(s.token, [s.version])));

  return { accountIds, shareTokens: shares.results.map((s) => s.token), stripeCustomerDeleted };
}

/** Deletes the Stripe customer (cancelling its subscriptions); true when there was one to delete. */
async function deleteStripeCustomer(env: AppEnv, customerId: string | null): Promise<boolean> {
  if (!customerId) return false;
  const stripe = billingConfigured(env) ? getStripe(env) : null;
  if (!stripe) {
    // Billing has been switched off since this customer was created, so nothing
    // here can reach Stripe; the operator has to delete the customer by hand.
    console.error(
      `Account deletion: Stripe is not configured; delete customer ${customerId} in Stripe`,
    );
    return false;
  }
  try {
    await stripe.customers.del(customerId);
    return true;
  } catch (err) {
    // Already deleted (in the Stripe dashboard, or by an earlier attempt that failed later on).
    if (err instanceof Stripe.errors.StripeInvalidRequestError && err.code === 'resource_missing') {
      return false;
    }
    console.error('Account deletion: Stripe customer deletion failed', err);
    throw new DomainError(
      'internal',
      "Couldn't cancel your billing with Stripe, so nothing was deleted. Please try again.",
    );
  }
}

function clearAuthCookies(c: AppContext): void {
  const https = new URL(c.req.url).protocol === 'https:';
  for (const name of AUTH_COOKIES) {
    deleteCookie(c, name, { path: '/' });
    if (https) deleteCookie(c, `__Secure-${name}`, { path: '/', secure: true });
  }
}

/**
 * `DELETE /api/account`, mounted under /api (signed-in session required).
 * Same-origin only, and the body must repeat the user's email: a forged or
 * stray request can't erase an account.
 */
export function accountDeletionRoutes(): Hono<AppBindings> {
  const r = new Hono<AppBindings>();
  r.delete('/', sameOriginOnly, validateJson(deleteAccountRequestSchema), async (c) => {
    const { userId, email } = c.var.identity;
    if (!userId || !email) {
      throw new ValidationError('There is no account to delete while sign-in is disabled');
    }
    const { confirmEmail } = c.req.valid('json');
    if (confirmEmail.toLowerCase() !== email.toLowerCase()) {
      throw new ValidationError('Type the email address you sign in with to confirm');
    }
    await deleteUser(c.env, userId);
    clearAuthCookies(c);
    clearKeyCookie(c);
    c.header('Cache-Control', 'no-store');
    return c.body(null, 204);
  });
  return r;
}
