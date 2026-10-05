import { ConflictError, DomainError, ValidationError } from '@tangent/core';
import {
  poolConsentRequestSchema,
  poolVerifyRequestSchema,
  type PoolConsentResponse,
  type PoolMeResponse,
  type PoolStatusResponse,
  type PoolVerifyResponse,
} from '@tangent/shared';
import { Hono, type Context } from 'hono';
import { clientIp } from '../auth/account.js';
import { turnstileHostname } from '../auth/auth.js';
import { poolAccessError } from '../billing/gate.js';
import { sameOriginOnly } from '../byok/guard.js';
import { appConfig } from '../config.js';
import type { AppBindings } from '../env.js';
import { validateJson } from '../http/errors.js';
import { recordConsent } from '../pool/consent.js';
import { markPoolVerified } from '../pool/identity.js';
import { cachedPoolStatus, poolMe } from '../pool/status.js';
import { TURNSTILE_ACTION, verifyTurnstile } from '../pool/turnstile.js';

/**
 * Community pool API, mounted at /api/pool behind the session and account
 * middleware (docs/pool/PLAN.md §S4). The contract is in
 * packages/shared/src/pool.ts and the route list in api.ts.
 *
 * `GET /me`: the caller's caps and use today, their verification, supporter
 * tier and own credit (the Learn app's pool pill and funding toggle).
 *
 * `POST /verify`: the first-pool-use Turnstile check, for accounts with no
 * pass on record (signed up before the check at sign-in). Records
 * `pool_verified_at` once and claims the account's pool identity; a mailbox
 * another account already uses is refused (`duplicate_identity`).
 *
 * `POST /consent`: the acknowledgment of the pool notice (`POOL_NOTICE_TEXT`)
 * at the version the client showed. Only the current version is accepted
 * (409 `conflict` otherwise: the client showed an outdated text); a repeat
 * keeps the first acknowledgment.
 */
export function poolRoutes(): Hono<AppBindings> {
  const r = new Hono<AppBindings>();
  r.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  r.get('/me', async (c) => c.json((await poolMe(c.env, c.var.account)) satisfies PoolMeResponse));

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

  r.post('/consent', sameOriginOnly, validateJson(poolConsentRequestSchema), async (c) => {
    const { userId } = c.var.identity;
    if (!userId)
      throw new DomainError('pool_unavailable', 'The community pool needs a signed-in account');
    const current = appConfig(c.env).pool.noticeVersion;
    if (c.req.valid('json').version !== current)
      throw new ConflictError('The community pool notice has changed; read the current one');
    return c.json((await recordConsent(c.env.DB, userId, current)) satisfies PoolConsentResponse);
  });

  return r;
}

/** The request's ExecutionContext; none when a test calls the app without one. */
export function waitUntilOf(c: Context<AppBindings>): { waitUntil(p: Promise<unknown>): void } {
  try {
    return c.executionCtx;
  } catch {
    return { waitUntil: () => undefined };
  }
}

/**
 * `GET /api/pool/status`, public (registered before the session middleware
 * by `createApp`): the pool meter, aggregates only, edge-cached for
 * `POOL_STATUS_MAX_AGE_S`. Browsers revalidate every read, so a meter read
 * after a purchase or a refusal is at most one edge lifetime stale.
 */
export async function poolStatusRoute(c: Context<AppBindings>): Promise<Response> {
  const status = await cachedPoolStatus(c.env, waitUntilOf(c));
  return c.json(status satisfies PoolStatusResponse, 200, {
    'Cache-Control': 'no-cache',
  });
}
