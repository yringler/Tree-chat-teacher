// Shared set-up of the open pool's HTTP tests (docs/pool/PLAN.md §6):
// a signed-in Learn user whose requests go to a pool of their own, so no two
// tests share a pool balance or its caps.
import { POOL_NOTICE_VERSION, type MeResponse } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { expect } from 'vitest';
import type { AppEnv } from '../src/env.js';
import { recordConsent } from '../src/pool/consent.js';
import { markPoolVerified } from '../src/pool/identity.js';
import { uniq } from './mocks/billing-helpers.js';
import { authEnv, client } from './session-client.js';

const env = rawEnv as unknown as AppEnv;

/** Before any test's real-clock rows: a grant made then is in the pool's 00:00 UTC balance. */
export const LONG_AGO = '2020-01-01T00:00:00.000Z';
/** The default funding of a test pool: far above any test's holds and caps. */
const POOL_FUNDS_MICROS = 10_000_000;

/** A grant to `poolId` (an admin adjustment), made long ago by default. */
export async function fundPool(
  poolId: string,
  micros: number,
  createdAt = LONG_AGO,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO credit_grants (id, account_id, kind, amount_micros, provider_ref, created_at)
     VALUES (?, ?, 'adjustment', ?, NULL, ?)`,
  )
    .bind(uniq('grant'), poolId, micros, createdAt)
    .run();
}

let emailSeq = 0;

/** The pool access columns of `userId` (`auth_users`). */
export async function poolAccess(userId: string) {
  return env.DB.prepare(
    'SELECT pool_suspended, pool_verified_at, pool_identity FROM auth_users WHERE id = ?',
  )
    .bind(userId)
    .first<{
      pool_suspended: number;
      pool_verified_at: string | null;
      pool_identity: string | null;
    }>();
}

/**
 * A signed-in user whose Worker env names a pool of its own (`POOL_ACCOUNT_ID`),
 * funded with `funds` µ$ (0 = empty). `overrides` reach the Worker only; the
 * Durable Objects run with the vitest.config.ts bindings, which is why every
 * pool parameter travels in the request's `AccountContext.pool`.
 *
 * The user signs in with a magic link, which needs a Turnstile pass, so they
 * are verified for the pool (`pool_verified_at`, `pool_identity`; set here if
 * the env had the pool off) unless `verified: false` clears it again (an
 * account from before the check).
 * They have acknowledged the current pool notice (`pool_consents`) unless
 * `consent: false` (a user who never saw it).
 * `ip` puts several users on one network; `email` picks the address.
 */
export async function poolReadyUser(
  opts: {
    poolId?: string;
    funds?: number;
    env?: Partial<AppEnv>;
    ip?: string;
    email?: string;
    verified?: boolean;
    consent?: boolean;
  } = {},
) {
  const poolId = opts.poolId ?? uniq('pool');
  const c = client(authEnv({ POOL_ACCOUNT_ID: poolId, ...opts.env }), { ip: opts.ip });
  const email =
    opts.email ?? `pool${++emailSeq}-${Math.random().toString(36).slice(2, 8)}@example.org`;
  await c.signIn(email);
  const res = await c.call('/api/me');
  expect(res.status).toBe(200);
  const me = (await res.json()) as MeResponse;
  const userId = me.userId!;
  if (opts.verified === false) {
    await env.DB.prepare(
      'UPDATE auth_users SET pool_verified_at = NULL, pool_identity = NULL WHERE id = ?',
    )
      .bind(userId)
      .run();
  } else if (!(await poolAccess(userId))?.pool_verified_at) {
    // Signed in while the pool was off (a test env), so the sign-in recorded nothing.
    await markPoolVerified(env.DB, userId, email);
  }
  if (opts.consent !== false) await recordConsent(env.DB, userId, POOL_NOTICE_VERSION);
  const funds = opts.funds ?? POOL_FUNDS_MICROS;
  if (funds > 0) await fundPool(poolId, funds);
  return { client: c, poolId, userId };
}
