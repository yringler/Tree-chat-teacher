import { DEFAULT_ACCOUNT_ID } from '@tangent/shared';
import { createMiddleware } from 'hono/factory';
import type { AppBindings, Identity } from '../env.js';

/**
 * Maps the verified caller to the account whose data it may touch.
 *
 * Single-user today: every caller that passed Cloudflare Access acts as the
 * built-in default account. Going multi-user means replacing this function
 * (e.g. look up / create an account for the Access `sub` claim) — routes and
 * services already take the account from here.
 */
export function resolveAccountId(_identity: Identity): string {
  return DEFAULT_ACCOUNT_ID;
}

/** Sets `c.var.accountId` for owner routes. Must run after the Access middleware. */
export const accountMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  c.set('accountId', resolveAccountId(c.var.identity));
  await next();
});
