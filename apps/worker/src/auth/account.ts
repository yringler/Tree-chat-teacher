import { DomainError } from '@tangent/core';
import {
  DEFAULT_ACCOUNT_ID,
  MODE_HEADER,
  PAYMENT_HEADER,
  type AccountMode,
  type LearnPayment,
} from '@tangent/shared';
import { createMiddleware } from 'hono/factory';
import { accountIdForUser } from '../billing/stripe.js';
import type { AccountContext, AppBindings, AppEnv, Identity } from '../env.js';
import { paidCreditAvailable } from '../services.js';
import { mayUseServerKeys } from './auth.js';

/** Prefix of power-mode account ids: `p_<Better Auth user id>`. */
export const POWER_ACCOUNT_PREFIX = 'p_';
/** Prefix of simple (Learn) account ids: `u_<Better Auth user id>`; it holds the billing ledger. */
export const SIMPLE_ACCOUNT_PREFIX = 'u_';
/** The dev bypass's Learn account (its power account is DEFAULT_ACCOUNT_ID). */
export const DEV_SIMPLE_ACCOUNT_ID = 'default_simple';

/** What the request asks for: the app it comes from, and how a Learn request pays. */
export interface AccountRequest {
  mode: AccountMode;
  payment: LearnPayment;
}

/** Reads MODE_HEADER and PAYMENT_HEADER; anything unexpected means power / own-key. */
export function accountRequest(headers: Headers): AccountRequest {
  return {
    mode: headers.get(MODE_HEADER) === 'simple' ? 'simple' : 'power',
    payment: headers.get(PAYMENT_HEADER) === 'credit' ? 'credit' : 'own-key',
  };
}

/**
 * Maps the verified caller and the app it uses to the account whose data it
 * may touch. The one place that decides it (docs/DECISIONS.md "Accounts"):
 * every user has a power account `p_<userId>` and a Learn account
 * `u_<userId>`, so the two apps keep separate conversations. The ids are
 * derived, so resolving them needs no lookup and can't race. The dev bypass
 * uses `default` and `default_simple`.
 *
 * `operatorKeys` (see AccountContext) never follows from the request alone:
 * power needs SERVER_KEY_EMAILS (or the dev bypass), and paid credit needs
 * the server to offer it. Asking for credit where it isn't offered falls back
 * to the user's own key, which never costs the operator anything.
 */
export function resolveAccount(
  env: AppEnv,
  identity: Identity,
  request: AccountRequest,
): AccountContext {
  const userId = identity.userId;
  if (!identity.devMode && !userId) throw new DomainError('unauthorized', 'Sign in required');
  if (request.mode === 'simple') {
    return {
      id: userId ? accountIdForUser(userId) : DEV_SIMPLE_ACCOUNT_ID,
      mode: 'simple',
      userId,
      operatorKeys: request.payment === 'credit' && paidCreditAvailable(env),
    };
  }
  return {
    id: userId ? POWER_ACCOUNT_PREFIX + userId : DEFAULT_ACCOUNT_ID,
    mode: 'power',
    userId,
    operatorKeys: identity.devMode || mayUseServerKeys(env, identity.email),
  };
}

// Account rows known to exist, per D1 binding, for this isolate's lifetime.
const ensured = new WeakMap<D1Database, Set<string>>();

/**
 * Creates the account row on first use (`INSERT OR IGNORE`, so concurrent
 * first requests are harmless). The `default` row is seeded by migration 0001
 * and carries no user id; so does the dev bypass's `default_simple`.
 */
export async function ensureAccountRow(db: D1Database, account: AccountContext): Promise<void> {
  let known = ensured.get(db);
  if (!known) {
    known = new Set();
    ensured.set(db, known);
  }
  if (known.has(account.id)) return;
  await db
    .prepare(
      'INSERT OR IGNORE INTO accounts (id, name, created_at, user_id, mode) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
    .bind(
      account.id,
      account.mode === 'simple' ? 'Learn account' : 'Power account',
      new Date().toISOString(),
      account.userId,
      account.mode,
    )
    .run();
  known.add(account.id);
}

/** Sets `c.var.account` / `c.var.accountId` for owner routes. Must run after the session middleware. */
export const accountMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const account = resolveAccount(c.env, c.var.identity, accountRequest(c.req.raw.headers));
  await ensureAccountRow(c.env.DB, account);
  c.set('account', account);
  c.set('accountId', account.id);
  await next();
});
