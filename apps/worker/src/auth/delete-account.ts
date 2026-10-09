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
import { appConfig } from '../config.js';
import type { AppBindings, AppContext, AppEnv } from '../env.js';
import { validateJson } from '../http/errors.js';
import { poolIdentity, releasePoolIdentityStatement } from '../pool/identity.js';
import { poolBank } from '../pool/ids.js';
import { purgeShare } from '../share/cache.js';
import { accountIdForUser, POWER_ACCOUNT_PREFIX } from './account.js';
import { logEvent } from '../log.js';

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
 *    rows, and the auth user (sessions, linked OAuth identities and passkeys
 *    cascade).
 * 3. Best-effort purge of their share links from this colo's edge cache.
 *    Other colos hold a copy for at most the share cache TTL; the D1 rows
 *    are gone, so nothing new is ever served.
 *
 * Not visited: the trees' Durable Objects. The Compare candidates one holds
 * (question and answers) are deleted by its alarm within `CANDIDATE_TTL_MS`,
 * as the privacy policy says; a call per tree here would be unbounded.
 *
 * Kept on purpose: the billing ledger (`credit_grants`, `usage_events`,
 * the pool's rows among them), which holds amounts, model names and token
 * counts but no message content. Tax and accounting law require keeping
 * payment records, and the pool's balance, checkpoint and day totals are
 * sums over them. Its usage rows lose their user id and network key
 * (`user_id`, `ip_key`) in the same batch, and so do grants on any ledger
 * but the user's own (pool adjustments), so the pool's records no longer
 * lead to the person, and the deleted account's spend counts toward nobody's
 * per-network caps. The user's own ledger `u_<userId>` leads nowhere once the
 * user row is gone. Also kept, for `POOL_IDENTITY_RETENTION_DAYS` after
 * this deletion and then purged by the daily cron: the user's pool identity
 * (`pool_identities`: a SHA-256 of the normalised email, its suspension, and
 * the day's pool usage, no address or user id), so signing up again with
 * the same mailbox neither lifts a pool suspension nor resets that day's
 * caps. PoolBank drops the user's per-minute counter. The privacy policy
 * (http/legal.ts, "How long we keep it") describes all of it.
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

  // The pool identity the user claimed; a suspension stays with the mailbox even before a claim.
  const identity =
    user.pool_identity ?? (user.pool_suspended ? await poolIdentity(user.email) : null);
  const poolId = appConfig(env).pool.accountId;

  const [p, u] = accountIds;
  await env.DB.batch([
    ...(identity
      ? [
          releasePoolIdentityStatement(env.DB, {
            identity,
            userId,
            poolId,
            suspended: user.pool_suspended === 1,
            now: new Date(),
          }),
        ]
      : []),
    env.DB.prepare('UPDATE usage_events SET user_id = NULL, ip_key = NULL WHERE user_id = ?1').bind(
      userId,
    ),
    env.DB.prepare(
      'UPDATE credit_grants SET user_id = NULL WHERE user_id = ?1 AND account_id <> ?2',
    ).bind(userId, u),
    env.DB.prepare('DELETE FROM pool_identity_holders WHERE user_id = ?1').bind(userId),
    env.DB.prepare('DELETE FROM trees WHERE account_id IN (?1, ?2)').bind(p, u),
    env.DB.prepare('DELETE FROM shares WHERE account_id IN (?1, ?2)').bind(p, u),
    env.DB.prepare('DELETE FROM account_settings WHERE account_id IN (?1, ?2)').bind(p, u),
    env.DB.prepare('DELETE FROM billing_subscriptions WHERE user_id = ?1').bind(userId),
    forgetCustomersStatement(env.DB, userId),
    env.DB.prepare('DELETE FROM auth_users WHERE id = ?1').bind(userId),
  ]);

  // Only the current version can still be cached: a republish purges the one before it.
  await Promise.all([
    ...shares.results.map((s) => purgeShare(s.token, [s.version])),
    forgetPoolRateCounter(env, poolId, userId),
  ]);

  return {
    accountIds,
    shareTokens: shares.results.map((s) => s.token),
    billingCustomerDeleted,
  };
}

/**
 * Best effort: the counter holds the user id for at most the minute it
 * counts and is dropped at the pool's next request after that, so a failure
 * is logged rather than failing a deletion that already happened.
 */
async function forgetPoolRateCounter(env: AppEnv, poolId: string, userId: string): Promise<void> {
  try {
    await poolBank(env, poolId).forgetUser(userId);
  } catch (err) {
    logEvent('warn', 'account_deletion_pool_counter_left', { error: err });
  }
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
      logEvent('error', 'account_deletion_customer_left', {
        userId,
        providers: held,
        reason: 'payments not configured: delete the customer by hand',
      });
    return false;
  }
  try {
    const customerRef = await customerRefFor(env.DB, provider.id, userId);
    return (await provider.deleteCustomer({ userId, customerRef })) === 'deleted';
  } catch (err) {
    logEvent('error', 'account_deletion_customer_failed', { userId, error: err });
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
