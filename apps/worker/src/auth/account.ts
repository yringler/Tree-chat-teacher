import { DEFAULT_ACCOUNT_ID } from '@tangent/shared';
import { createMiddleware } from 'hono/factory';
import type { AppBindings, Identity } from '../env.js';

/**
 * Maps the verified caller to the account whose data it may touch.
 *
 * Single-user today: every signed-in user (all of them are on ALLOWED_EMAILS)
 * acts as the built-in default account. Going multi-user means replacing this
 * function (e.g. look up / create an account for `identity.userId`, the
 * Better Auth user id) — routes and services already take the account from here.
 */
export function resolveAccountId(_identity: Identity): string {
  return DEFAULT_ACCOUNT_ID;
}

/** Sets `c.var.account` / `c.var.accountId` for owner routes. Must run after the session middleware. */
export const accountMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  // wave 2: worker-core replaces this with resolveAccount (simple accounts, row ensured).
  const id = resolveAccountId(c.var.identity);
  c.set('account', { id, mode: 'power', userId: c.var.identity.userId });
  c.set('accountId', id);
  await next();
});
