import { DomainError, ValidationError } from '@tangent/core';
import { deleteAccountRequestSchema } from '@tangent/shared';
import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import {
  customerProvidersOf,
  customerRefFor,
  forgetCustomersStatement,
} from '../billing/payments/customers.js';
import { paymentProvider } from '../billing/payments/index.js';
import { clearKeyCookie } from '../byok/keys.js';
import type { AppBindings, AppContext, AppEnv } from '../env.js';
import { validateJson } from '../http/errors.js';
import { poolIdentity } from '../pool/identity.js';
import { purgeShare } from '../share/cache.js';
import { accountIdForUser, POWER_ACCOUNT_PREFIX } from './account.js';

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
  /** The payment provider held a customer for the user, and it was deleted (or anonymised). */
  billingCustomerDeleted: boolean;
}

/**
 * Permanently deletes a Better Auth user and everything they own, in this order:
 *
 * 1. Their customer at the payment provider, if any: every subscription is
 *    ended and the customer deleted or anonymised (`deleteCustomer`), so no
 *    membership keeps charging a user who no longer exists. A failure here
 *    aborts the whole deletion: better a retry than a subscription with
 *    nobody behind it.
 * 2. In one D1 batch (a transaction): both accounts' trees (branches, nodes,
 *    summaries and shares with their snapshots go by ON DELETE CASCADE),
 *    any share or setting left over, their subscription and payment-customer
 *    rows, the account
 *    rows, the open pool notice acknowledgments (`pool_consents`), and the auth
 *    user (sessions, linked OAuth identities and passkeys cascade).
 * 3. Best-effort purge of their share links from this colo's edge cache.
 *    Other colos hold a copy for at most the share cache TTL; the D1 rows
 *    are gone, so nothing new is ever served.
 *
 * Not visited: the trees' Durable Objects. The Compare candidates one holds
 * (question and answers) are deleted by its alarm within `CANDIDATE_TTL_MS`,
 * as the privacy policy says; a call per tree here would be unbounded.
 *
 * Kept on purpose: the billing ledger (`credit_grants`, `usage_events`),
 * which holds amounts, model names and token counts but no message content.
 * Tax and accounting law require keeping payment records, and once the
 * user row is gone the `u_<userId>` id leads nowhere. The privacy policy
 * (http/legal.ts) says so. Also kept: the open pool's identity records
 * (`pool_identity_holders`, `pool_identities`: a SHA-256 of the normalised
 * email, user ids and a suspension flag, no address), and a suspended user's
 * suspension is written there first, so signing up again with the same
 * mailbox neither lifts a pool suspension nor resets the pool's daily caps.
 */
export async function deleteUser(env: AppEnv, userId: string): Promise<DeletedUser> {
  const accountIds = [POWER_ACCOUNT_PREFIX + userId, accountIdForUser(userId)];

  const user = await env.DB.prepare(
    `SELECT email, pool_suspended, pool_identity FROM auth_users WHERE id = ?1`,
  )
    .bind(userId)
    .first<{
      email: string;
      pool_suspended: number;
      pool_identity: string | null;
    }>();
  if (!user) throw new DomainError('not_found', 'Account not found');

  const billingCustomerDeleted = await deleteBillingCustomer(env, userId);

  const shares = await env.DB.prepare(
    'SELECT token, version FROM shares WHERE account_id IN (?1, ?2)',
  )
    .bind(...accountIds)
    .all<{ token: string; version: number }>();

  // A pool suspension stays with the mailbox (its pool identity, claimed or not yet).
  const suspendedIdentity = user.pool_suspended
    ? (user.pool_identity ?? (await poolIdentity(user.email)))
    : null;

  const [p, u] = accountIds;
  await env.DB.batch([
    ...(suspendedIdentity
      ? [
          env.DB.prepare(
            `INSERT INTO pool_identities (identity, suspended) VALUES (?1, 1)
             ON CONFLICT(identity) DO UPDATE SET suspended = 1`,
          ).bind(suspendedIdentity),
        ]
      : []),
    env.DB.prepare('DELETE FROM trees WHERE account_id IN (?1, ?2)').bind(p, u),
    env.DB.prepare('DELETE FROM shares WHERE account_id IN (?1, ?2)').bind(p, u),
    env.DB.prepare('DELETE FROM account_settings WHERE account_id IN (?1, ?2)').bind(p, u),
    env.DB.prepare('DELETE FROM billing_subscriptions WHERE user_id = ?1').bind(userId),
    forgetCustomersStatement(env.DB, userId),
    env.DB.prepare('DELETE FROM pool_consents WHERE user_id = ?1').bind(userId),
    env.DB.prepare('DELETE FROM accounts WHERE user_id = ?1 OR id IN (?2, ?3)').bind(userId, p, u),
    env.DB.prepare('DELETE FROM auth_users WHERE id = ?1').bind(userId),
  ]);

  // Only the current version can still be cached: a republish purges the one before it.
  await Promise.all(shares.results.map((s) => purgeShare(s.token, [s.version])));

  return {
    accountIds,
    shareTokens: shares.results.map((s) => s.token),
    billingCustomerDeleted,
  };
}

/**
 * Ends the user's subscriptions and deletes their customer at the payment
 * provider; true when there was one. Asked even without a recorded customer:
 * a checkout may have created one the webhooks haven't told us about yet.
 */
async function deleteBillingCustomer(env: AppEnv, userId: string): Promise<boolean> {
  const provider = paymentProvider(env);
  if (!provider) {
    const held = await customerProvidersOf(env.DB, userId);
    // Payments were switched off since this customer was created: nothing here can reach the
    // provider, so the operator has to delete the customer by hand.
    if (held.length > 0)
      console.error(
        `Account deletion: payments are not configured; delete user ${userId}'s customer at ${held.join(', ')} by hand`,
      );
    return false;
  }
  try {
    const customerRef = await customerRefFor(env.DB, provider.id, userId);
    return (await provider.deleteCustomer({ userId, customerRef })) === 'deleted';
  } catch (err) {
    console.error('Account deletion: payment customer deletion failed', err);
    throw new DomainError(
      'internal',
      "Couldn't cancel your billing with our payment provider, so nothing was deleted. Please try again.",
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
  r.delete('/', validateJson(deleteAccountRequestSchema), async (c) => {
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
