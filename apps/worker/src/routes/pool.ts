import { DomainError, ValidationError } from '@tangent/core';
import { poolVerifyRequestSchema, type PoolVerifyResponse } from '@tangent/shared';
import { Hono } from 'hono';
import { clientIp } from '../auth/account.js';
import { turnstileHostname } from '../auth/auth.js';
import { poolAccessError } from '../billing/gate.js';
import { sameOriginOnly } from '../byok/guard.js';
import type { AppBindings } from '../env.js';
import { validateJson } from '../http/errors.js';
import { markPoolVerified } from '../pool/identity.js';
import { TURNSTILE_ACTION, verifyTurnstile } from '../pool/turnstile.js';

/**
 * Community pool API, mounted at /api/pool behind the session and account
 * middleware (docs/pool/PLAN.md §S4). The contract is in
 * packages/shared/src/pool.ts and the route list in api.ts.
 *
 * `POST /verify`: the first-pool-use Turnstile check, for accounts with no
 * pass on record (signed up before the check at sign-in). Records
 * `pool_verified_at` once and claims the account's pool identity; a mailbox
 * another account already uses is refused (`duplicate_identity`).
 */
export function poolRoutes(): Hono<AppBindings> {
  const r = new Hono<AppBindings>();
  r.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  r.post('/verify', sameOriginOnly, validateJson(poolVerifyRequestSchema), async (c) => {
    const { userId, email } = c.var.identity;
    if (!userId || !email)
      throw new DomainError('pool_unavailable', 'The community pool needs a signed-in account');
    const passed = await verifyTurnstile(
      c.env,
      c.req.valid('json').token,
      clientIp(c.req.raw.headers),
      { action: TURNSTILE_ACTION, hostname: turnstileHostname(c.env, c.req.raw) },
    );
    if (!passed) throw new ValidationError("The human check didn't go through; please try again");
    if ((await markPoolVerified(c.env.DB, userId, email)) === 'duplicate')
      throw poolAccessError('duplicate_identity');
    return c.json({ verified: true } satisfies PoolVerifyResponse);
  });

  return r;
}
