// Shared set-up of the community pool's HTTP tests (docs/pool/PLAN.md §6):
// a signed-in Learn user whose requests go to a pool of their own, so no two
// tests share a pool balance or its caps.
import type { MeResponse } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { expect } from 'vitest';
import type { AppEnv } from '../src/env.js';
import { uniq } from './mocks/billing-helpers.js';
import { authEnv, client } from './session-client.js';

const env = rawEnv as unknown as AppEnv;

/** Before any test's real-clock rows: a grant made then is in the pool's 00:00 UTC balance. */
export const LONG_AGO = '2020-01-01T00:00:00.000Z';
/** The default funding of a test pool: far above any test's holds and caps. */
export const POOL_FUNDS_MICROS = 10_000_000;

/** A grant to `poolId` (an admin adjustment), made long ago by default. */
export async function fundPool(
  poolId: string,
  micros: number,
  createdAt = LONG_AGO,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO credit_grants (id, account_id, kind, amount_micros, stripe_ref, created_at)
     VALUES (?, ?, 'adjustment', ?, NULL, ?)`,
  )
    .bind(uniq('grant'), poolId, micros, createdAt)
    .run();
}

let emailSeq = 0;

/**
 * A signed-in user whose Worker env names a pool of its own (`POOL_ACCOUNT_ID`),
 * funded with `funds` µ$ (0 = empty). `overrides` reach the Worker only; the
 * Durable Objects run with the vitest.config.ts bindings, which is why every
 * pool parameter travels in the request's `AccountContext.pool`.
 */
export async function poolReadyUser(
  opts: { poolId?: string; funds?: number; env?: Partial<AppEnv> } = {},
) {
  const poolId = opts.poolId ?? uniq('pool');
  const c = client(authEnv({ POOL_ACCOUNT_ID: poolId, ...opts.env }));
  await c.signIn(`pool${++emailSeq}-${Math.random().toString(36).slice(2, 8)}@example.org`);
  const res = await c.call('/api/me');
  expect(res.status).toBe(200);
  const me = (await res.json()) as MeResponse;
  const funds = opts.funds ?? POOL_FUNDS_MICROS;
  if (funds > 0) await fundPool(poolId, funds);
  return { client: c, poolId, userId: me.userId! };
}
