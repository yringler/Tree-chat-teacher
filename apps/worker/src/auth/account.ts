import { DEFAULT_ACCOUNT_ID } from '@tangent/shared';
import { createMiddleware } from 'hono/factory';
import type { AppBindings, Identity } from '../env.js';

/**
 * Maps the verified caller to the account whose data it may touch.
 *
 * One account per user, keyed on the Better Auth user id (stable, unlike the
 * email). The built-in default account is only used by the local dev bypass,
 * which has no user; migration 0003 handed its earlier data to the first user.
 */
export function resolveAccountId(identity: Identity): string {
  return identity.userId ?? DEFAULT_ACCOUNT_ID;
}

/** Sets `c.var.accountId` for owner routes. Must run after the session middleware. */
export const accountMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  c.set('accountId', resolveAccountId(c.var.identity));
  await next();
});
