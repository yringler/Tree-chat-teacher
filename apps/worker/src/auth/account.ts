import { DomainError } from '@tangent/core';
import { DEFAULT_ACCOUNT_ID } from '@tangent/shared';
import { createMiddleware } from 'hono/factory';
import type { AccountContext, AppBindings, AppEnv, Identity } from '../env.js';
import { isEmailAllowed, openSignup } from './auth.js';

/** Prefix of personal (simple) account ids: `u_<Better Auth user id>`. */
export const SIMPLE_ACCOUNT_PREFIX = 'u_';

/**
 * Maps the verified caller to the account whose data it may touch. The one
 * place that decides it (docs/DECISIONS.md "Accounts"):
 * - dev bypass, or an email on ALLOWED_EMAILS → the shared `default` account,
 *   `power` mode (own provider keys, unmetered);
 * - any other signed-in user while OPEN_SIGNUP=true → their personal account
 *   `u_<userId>`, `simple` mode (operator's key, metered). The id is derived,
 *   so resolving it needs no lookup and can't race;
 * - anyone else → 403.
 */
export function resolveAccount(env: AppEnv, identity: Identity): AccountContext {
  if (identity.devMode || isEmailAllowed(env, identity.email)) {
    return { id: DEFAULT_ACCOUNT_ID, mode: 'power', userId: identity.userId };
  }
  if (openSignup(env) && identity.userId) {
    return { id: SIMPLE_ACCOUNT_PREFIX + identity.userId, mode: 'simple', userId: identity.userId };
  }
  throw new DomainError('forbidden', 'This account is not allowed to use this app');
}

// Account rows known to exist, per D1 binding, for this isolate's lifetime.
const ensured = new WeakMap<D1Database, Set<string>>();

/**
 * Creates the account row on first use (`INSERT OR IGNORE`, so concurrent
 * first requests are harmless). The shared `default` row is seeded by
 * migration 0001 and carries no user id.
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
      account.mode === 'simple' ? 'Personal account' : 'Default account',
      new Date().toISOString(),
      account.mode === 'simple' ? account.userId : null,
      account.mode,
    )
    .run();
  known.add(account.id);
}

/** Sets `c.var.account` / `c.var.accountId` for owner routes. Must run after the session middleware. */
export const accountMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const account = resolveAccount(c.env, c.var.identity);
  await ensureAccountRow(c.env.DB, account);
  c.set('account', account);
  c.set('accountId', account.id);
  await next();
});
