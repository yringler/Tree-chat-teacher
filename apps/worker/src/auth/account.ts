import { DomainError } from '@tangent/core';
import {
  DEFAULT_ACCOUNT_ID,
  MODE_HEADER,
  PAYMENT_HEADER,
  type AccountMode,
  type LearnPayment,
} from '@tangent/shared';
import { createMiddleware } from 'hono/factory';
import type { AccountContext, AppBindings, AppEnv, Identity } from '../env.js';
import { ipKey, utcDay } from '../pool/ids.js';
import { resolvePoolParams } from '../pool/params.js';
import { builtInAvailable, poolAvailable } from '../services.js';

/** Prefix of power-mode account ids: `p_<Better Auth user id>`. */
export const POWER_ACCOUNT_PREFIX = 'p_';
/** Prefix of simple (Learn) account ids: `u_<Better Auth user id>`, also the user's ledger id. */
export const SIMPLE_ACCOUNT_PREFIX = 'u_';
/** The dev bypass's Learn account (its power account is DEFAULT_ACCOUNT_ID), and its ledger id. */
export const DEV_SIMPLE_ACCOUNT_ID = 'default_simple';

/**
 * A Better Auth user's Learn account id, `u_<userId>`, which is also the
 * ledger id of their credit in both modes (`AccountContext.billingAccountId`).
 */
export function accountIdForUser(userId: string): string {
  return `${SIMPLE_ACCOUNT_PREFIX}${userId}`;
}

/**
 * The ledger id of a user's credit and usage, the same in both modes:
 * `u_<userId>`, or `default_simple` for the dev bypass (no user id).
 */
export function billingAccountIdFor(userId: string | null): string {
  return userId ? accountIdForUser(userId) : DEV_SIMPLE_ACCOUNT_ID;
}

/**
 * The Better Auth user id behind an account id (`p_<userId>` / `u_<userId>`);
 * null for the dev bypass's `default` and `default_simple`.
 */
export function userIdOfAccount(accountId: string): string | null {
  for (const prefix of [POWER_ACCOUNT_PREFIX, SIMPLE_ACCOUNT_PREFIX]) {
    if (accountId.startsWith(prefix) && accountId.length > prefix.length)
      return accountId.slice(prefix.length);
  }
  return null;
}

/** What the request asks for: the app it comes from, and how a Learn request pays. */
export interface AccountRequest {
  mode: AccountMode;
  payment: LearnPayment;
}

const PAYMENTS: ReadonlySet<string> = new Set<LearnPayment>(['own-key', 'credit', 'pool']);

/** Reads MODE_HEADER and PAYMENT_HEADER; anything unexpected means power / own-key. */
export function accountRequest(headers: Headers): AccountRequest {
  const payment = headers.get(PAYMENT_HEADER) ?? '';
  return {
    mode: headers.get(MODE_HEADER) === 'simple' ? 'simple' : 'power',
    payment: PAYMENTS.has(payment) ? (payment as LearnPayment) : 'own-key',
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
 *
 * Funding (`AccountContext.funding`): Learn's `credit` is `personal` where
 * credit is offered (else `own-key`, as above); `pool` is the community pool,
 * `builtIn` only while the pool is on (`poolAvailable`) and for a signed-in
 * user (the dev bypass has no user to cap); `own-key` otherwise. Power is
 * always `personal` and never uses the pool, whatever the header says. The
 * pool's parameters are added by `withPoolParams` (they need the caller's
 * network), and a send whose credit runs out may still move to the pool
 * (billing/gate.ts `resolveFunding`).
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
    const simple = { id: billingAccountId, mode: 'simple', userId, billingAccountId } as const;
    if (request.payment === 'pool') {
      const builtIn = userId !== null && poolAvailable(env);
      return { ...simple, builtIn, operatorKeys: false, funding: 'pool' };
    }
    const credit = request.payment === 'credit' && builtInAvailable(env);
    return {
      ...simple,
      builtIn: credit,
      operatorKeys: false,
      funding: credit ? 'personal' : 'own-key',
    };
  }
  return {
    id: userId ? POWER_ACCOUNT_PREFIX + userId : DEFAULT_ACCOUNT_ID,
    mode: 'power',
    userId,
    billingAccountId,
    builtIn: builtInAvailable(env),
    operatorKeys: identity.devMode,
    funding: 'personal',
  };
}

/** The caller's network key for the pool's per-network caps; null without an address or a secret. */
async function poolIpKey(env: AppEnv, ip: string | null, now = new Date()): Promise<string | null> {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret || !ip?.trim()) return null;
  return ipKey(secret, utcDay(now), ip);
}

/**
 * `account` as the community pool funds it: the pool's parameters resolved
 * from this request's env and the caller's network (`ip`), `builtIn` while
 * the pool is on and the caller is signed in. A no-op for power, and for an
 * account that is not pool-funded and not asked to become so (`toPool`).
 */
export async function withPoolParams(
  env: AppEnv,
  account: AccountContext,
  ip: string | null,
  toPool = false,
): Promise<AccountContext> {
  if (account.mode !== 'simple' || (account.funding !== 'pool' && !toPool)) return account;
  const builtIn = account.userId !== null && poolAvailable(env);
  if (!builtIn) return { ...account, funding: 'pool', builtIn: false };
  return {
    ...account,
    funding: 'pool',
    builtIn,
    pool: resolvePoolParams(env, await poolIpKey(env, ip)),
  };
}

/** The address the request comes from (Cloudflare's `cf-connecting-ip`). */
export function clientIp(headers: Headers): string | null {
  return headers.get('cf-connecting-ip');
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
  const headers = c.req.raw.headers;
  const account = await withPoolParams(
    c.env,
    resolveAccount(c.env, c.var.identity, accountRequest(headers)),
    clientIp(headers),
  );
  await ensureAccountRow(c.env.DB, account);
  c.set('account', account);
  c.set('accountId', account.id);
  await next();
});
