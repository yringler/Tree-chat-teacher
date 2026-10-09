// The open pool's public surfaces: the meter
// (`GET /api/pool/status`, also on the landing page), the caller's standing
// (`GET /api/pool/me`), and how the pages name the pool's model
// (`poolModelInfo`). The pages themselves are in public-pages.test.ts.
import type { PoolMeResponse, PoolModelInfo, PoolStatusResponse } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { appConfig, DEFAULT_BACKGROUND_MODEL, DEFAULT_LEARN_MAX_MODEL } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { POOL_SESSION_ESTIMATE_MICROS } from '../src/pool/params.js';
import { poolModelInfo, poolStatus } from '../src/pool/status.js';
import { envWithFailingDb, uniq } from './mocks/billing-helpers.js';
import { fundPool, poolReadyUser } from './pool-helpers.js';
import { shippedEnv } from './mocks/wrangler-vars.js';
import { authEnv } from './session-client.js';
import { BASE } from './http.js';

const env = rawEnv as unknown as AppEnv;

/** A request without a session, as a visitor's browser sends it. */
function visitor(e: AppEnv) {
  const app = createApp();
  return (path: string) => app.request(`${BASE}${path}`, {}, e);
}

/** An env (auth configured) whose pool is `poolId`, asking its model with a low effort as deployed. */
function poolEnv(poolId: string, overrides: Partial<AppEnv> = {}): AppEnv {
  return authEnv({ TEST_POOL_ACCOUNT_ID: poolId, POOL_EFFORT: 'low', ...overrides });
}

/** A settled pool row of `userId` (no pending rows: other suites' crons would expire them). */
async function settledReply(
  poolId: string,
  userId: string,
  chargeMicros: number,
  opts: { reason?: string; purpose?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage_events (id, account_id, funding, user_id, purpose, provider_id, model, status,
       hold_micros, markup_bps, fee_bps, charge_micros, settle_reason, created_at)
     VALUES (?, ?, 'pool', ?, ?, 'openrouter', 'normal', 'settled', 5000, 0, 0, ?, ?, ?)`,
  )
    .bind(
      uniq('use'),
      poolId,
      userId,
      opts.purpose ?? 'reply',
      chargeMicros,
      opts.reason ?? (chargeMicros > 0 ? 'cost' : 'released'),
      new Date().toISOString(),
    )
    .run();
}

describe('GET /api/pool/status', () => {
  it('is public, edge-cached for a minute (not by browsers), and aggregates only', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 1_000_000);
    const res = await visitor(poolEnv(poolId))('/api/pool/status');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    const status = (await res.json()) as PoolStatusResponse;
    expect(status).toEqual({
      enabled: true,
      availableMicros: 1_000_000,
      sessionsRemaining: Math.floor(1_000_000 / POOL_SESSION_ESTIMATE_MICROS),
      // The fake's Normal, asked with the pool's effort (`POOL_EFFORT`, which the fake's
      // listing doesn't set) and its shorter reply cap.
      model: { id: 'normal', label: 'Normal', thinking: 'other', replies: 'shorter' },
    });
    // The edge copy answers the next minute's visitors, whatever D1 says meanwhile.
    await fundPool(poolId, 2_000_000);
    const again = (await (
      await visitor(poolEnv(poolId))('/api/pool/status')
    ).json()) as PoolStatusResponse;
    expect(again.availableMicros).toBe(1_000_000);
  });

  it('reports the balance net of every charge and hold, and no user', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 500_000);
    const [a, b] = [uniq('user'), uniq('user')];
    await settledReply(poolId, a, 1_200);
    await settledReply(poolId, b, 0, { reason: 'released' });
    await settledReply(poolId, b, 700, { purpose: 'summary' });

    const status = await poolStatus(poolEnv(poolId));
    expect(status.availableMicros).toBe(500_000 - 1_200 - 700);
    expect(JSON.stringify(status)).not.toMatch(new RegExp(`${a}|${b}`));
  });

  it('says the pool is off, with nothing read, while POOL_ENABLED is off', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 1_000_000);
    const off = envWithFailingDb(poolEnv(poolId, { POOL_ENABLED: 'false' }), /usage_events/);
    const status = await poolStatus(off);
    expect(status).toMatchObject({ enabled: false, availableMicros: 0, sessionsRemaining: 0 });
  });

  it('is on with or without payments, and offers nothing to buy', async () => {
    const status = await poolStatus(poolEnv(uniq('pool'), { PAYMENT_PROVIDER: 'polar' }));
    expect(status).toMatchObject({ enabled: true });
    expect(status).not.toHaveProperty('fundingOpen');
    expect(status).not.toHaveProperty('markupBps');
  });
});

describe('GET /api/pool/me', () => {
  it('reports today’s caps and use, and the caller’s own credit', async () => {
    const { client, poolId, userId } = await poolReadyUser();
    await settledReply(poolId, userId, 2_000);
    await settledReply(poolId, userId, 0, { reason: 'released' });
    const res = await client.call('/api/pool/me', { learn: 'pool' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const me = (await res.json()) as PoolMeResponse;
    const caps = appConfig(client.env).pool.caps.user;
    expect(me).toEqual({
      available: true,
      verified: true,
      suspended: false,
      caps: {
        requestsPerDay: caps.requestsPerDay,
        spendMicrosPerDay: caps.spendMicrosPerDay,
        // The released reply never reached the model: it counts toward neither.
        usedRequests: 1,
        usedSpendMicros: 2_000,
        resetAt: expect.stringMatching(/T00:00:00\.000Z$/),
      },
      personalAvailableMicros: 0,
    });
  });

  it('needs a session', async () => {
    const res = await visitor(poolEnv(uniq('pool')))('/api/pool/me');
    expect(res.status).toBe(401);
  });
});

describe('poolModelInfo', () => {
  /** The pool's model as shipped, with `overrides`: Normal's model, asked by the pool's settings. */
  const info = (overrides: Partial<AppEnv>) => poolModelInfo(shippedEnv(env, overrides));
  const normal = { id: DEFAULT_BACKGROUND_MODEL, label: 'Normal' };

  it.each<[string, Partial<AppEnv>, PoolModelInfo]>([
    [
      'as shipped: less thinking, shorter replies',
      {},
      { ...normal, thinking: 'lighter', replies: 'shorter' },
    ],
    ['asked like Normal', { POOL_EFFORT: 'high', POOL_MAX_OUTPUT_TOKENS: '16384' }, normal],
    [
      'longer replies',
      { POOL_EFFORT: 'high', POOL_MAX_OUTPUT_TOKENS: '32000' },
      { ...normal, replies: 'longer' },
    ],
    [
      'no thinking',
      { POOL_EFFORT: 'none' },
      { ...normal, thinking: 'lighter', replies: 'shorter' },
    ],
    [
      'more thinking than the tier',
      { LEARN_NORMAL_EFFORT: 'low', POOL_EFFORT: 'high' },
      { ...normal, thinking: 'more', replies: 'shorter' },
    ],
    [
      'a model that is no tier',
      { BACKGROUND_MODEL: 'deepseek/deepseek-v4-flash' },
      { id: 'deepseek/deepseek-v4-flash', label: 'Lite' },
    ],
    [
      "Max's model, asked like Max",
      { POOL_MODEL: DEFAULT_LEARN_MAX_MODEL, POOL_EFFORT: '', POOL_MAX_OUTPUT_TOKENS: '16384' },
      { id: DEFAULT_LEARN_MAX_MODEL, label: 'Max' },
    ],
  ])('%s', (_, overrides, expected) => {
    expect(info(overrides)).toEqual(expected);
  });
});
