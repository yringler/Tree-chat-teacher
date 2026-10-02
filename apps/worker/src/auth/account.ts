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
import { builtInAvailable } from '../services.js';

/** Prefix of power-mode account ids: `p_<Better Auth user id>`. */
export const POWER_ACCOUNT_PREFIX = 'p_';
/** Prefix of simple (Learn) account ids: `u_<Better Auth user id>`, also the user's ledger id. */
export const SIMPLE_ACCOUNT_PREFIX = 'u_';
/** The dev bypass's Learn account (its power account is DEFAULT_ACCOUNT_ID), and its ledger id. */
export const DEV_SIMPLE_ACCOUNT_ID = 'default_simple';

/**
 * The ledger id of a user's credit and usage, the same in both modes:
 * `u_<userId>`, or `default_simple` for the dev bypass (no user id).
 */
export function billingAccountIdFor(userId: string | null): string {
  return userId ? accountIdForUser(userId) : DEV_SIMPLE_ACCOUNT_ID;
}

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
 * Credit is per user: both accounts spend the ledger at `billingAccountId`
 * (`u_<userId>`, the Learn account's id, so Learn balances carry over).
 *
 * Spending the operator's keys never follows from the request alone (see
 * AccountContext): `builtIn` needs the server to offer the built-in provider
 * (`builtInAvailable`), and Learn also has to ask for credit; asking where it
 * isn't offered falls back to the user's own key, which never costs the
 * operator anything. `operatorKeys` (the power configs' server secrets) is
 * the local dev bypass only.
 */
export function resolveAccount(
  env: AppEnv,
  identity: Identity,
  request: AccountRequest,
): AccountContext {
  const userId = identity.userId;
  if (!identity.devMode && !userId) throw new DomainError('unauthorized', 'Sign in required');
  const billingAccountId = billingAccountIdFor(userId);
  if (request.mode === 'simple') {
    return {
      id: billingAccountId,
      mode: 'simple',
      userId,
      billingAccountId,
      builtIn: request.payment === 'credit' && builtInAvailable(env),
      operatorKeys: false,
    };
  }
  return {
    id: userId ? POWER_ACCOUNT_PREFIX + userId : DEFAULT_ACCOUNT_ID,
    mode: 'power',
    userId,
    billingAccountId,
    builtIn: builtInAvailable(env),
    operatorKeys: identity.devMode,
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
