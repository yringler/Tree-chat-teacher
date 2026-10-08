import { createProviderRegistry } from '@tangent/providers';
import type {
  GenerateRequest,
  LlmProvider,
  ProviderEvent,
  ProviderInfo,
  ProviderRegistry,
  UsageTag,
} from '@tangent/shared';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBalance } from '../src/billing/ledger.js';
import {
  createPoolUsageMeter,
  meteredRegistry,
  type UsageMeterOptions,
} from '../src/billing/meter.js';
import { reconcilePendingUsage, reconcilePoolUsage } from '../src/billing/reconcile.js';
import { markDispatched, setGenerationId, settleUsage } from '../src/billing/usage-store.js';
import type { PoolCaps, PoolRateLimits } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { expirePoolReservations } from '../src/pool/expiry.js';
import { poolBank } from '../src/pool/ids.js';
import {
  poolReserveRequest,
  replyCeilingMicros,
  resolvePoolParams,
  type PoolParams,
} from '../src/pool/params.js';
import type { PoolReserveRequest, PoolReserveResult } from '../src/pool/pool-bank.js';
import { simpleProviderConfig } from '../src/simple-mode.js';
import { scriptGeneration, uniq, usageRow, type UsageRow } from './mocks/billing-helpers.js';
import { shippedVars } from './mocks/wrangler-vars.js';

const env = rawEnv as unknown as AppEnv;
/** The pool params of the test env (its price is a `MODEL_PRICES` entry: no D1 read). */
const BASE_PARAMS = await resolvePoolParams(env, null);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TTL = 10 * MIN;
const GIVE_UP = HOUR;
/** Before any test's real-clock rows: grants made then count in full at 00:00 UTC today. */
const LONG_AGO = '2020-01-01T00:00:00.000Z';
const FAST: UsageMeterOptions = { retryDelaysMs: [5, 5], settleRetryDelaysMs: [5] };

/** Caps that never bind, unless a test lowers one. */
const OPEN_CAPS: PoolCaps = {
  user: { requestsPerDay: 1_000_000, spendMicrosPerDay: 1e12 },
  global: { spendMicrosPerDay: 1e12, bpsOfMorningBalance: 1e9 },
  ip: { requestsPerDay: 1_000_000, spendMicrosPerDay: 1e12 },
};
const NO_BREAKER = { windowMs: DAY, maxMicros: 1e12 };
const OPEN_LIMITS: PoolRateLimits = { userPerMinute: 1_000_000, ipPerMinute: 1_000_000 };

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet(): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A grant to the pool, made long ago by default (so it is in the 00:00 UTC balance). */
async function fund(poolId: string, micros: number, createdAt = LONG_AGO): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO credit_grants (id, account_id, kind, amount_micros, provider_ref, created_at)
     VALUES (?, ?, 'adjustment', ?, NULL, ?)`,
  )
    .bind(uniq('grant'), poolId, micros, createdAt)
    .run();
}

/** A credit purchase by `userId` (it changes nothing about their pool caps). */
async function purchase(userId: string, grossMicros = 5_000_000): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO credit_grants (id, account_id, kind, amount_micros, gross_micros, user_id, provider_ref, created_at)
     VALUES (?, ?, 'purchase', ?, ?, ?, ?, ?)`,
  )
    .bind(uniq('grant'), uniq('elsewhere'), grossMicros, grossMicros, userId, uniq('cs'), LONG_AGO)
    .run();
}

async function available(poolId: string): Promise<number> {
  const b = await getBalance(env.DB, poolId);
  return b.balanceMicros - b.heldMicros;
}

async function poolRows(poolId: string): Promise<UsageRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM usage_events WHERE account_id = ? ORDER BY created_at, id',
  )
    .bind(poolId)
    .all<UsageRow>();
  return results;
}

function request(poolId: string, overrides: Partial<PoolReserveRequest> = {}): PoolReserveRequest {
  return {
    poolId,
    userId: uniq('user'),
    ipKey: null,
    purpose: 'reply',
    treeId: 'tree_1',
    branchId: 'branch_1',
    nodeId: null,
    providerId: 'openrouter',
    model: 'simple',
    holdMicros: 3_000,
    feeBps: 0,
    caps: OPEN_CAPS,
    limits: OPEN_LIMITS,
    overage: NO_BREAKER,
    expiry: { ttlMs: TTL, giveUpMs: GIVE_UP, batch: 20 },
    ...overrides,
  };
}

function reserve(
  poolId: string,
  overrides: Partial<PoolReserveRequest> = {},
): Promise<PoolReserveResult> {
  return poolBank(env, poolId).reserve(request(poolId, overrides));
}

async function reserved(
  poolId: string,
  overrides: Partial<PoolReserveRequest> = {},
): Promise<string> {
  const result = await reserve(poolId, overrides);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.usageId;
}

/** A pending pool row stamped `createdAt`, written directly (rows "from the past"). */
async function insertPoolRow(
  poolId: string,
  createdAt: string,
  extra: { status?: string; chargeMicros?: number | null; holdMicros?: number } = {},
): Promise<string> {
  const id = uniq('use');
  await env.DB.prepare(
    `INSERT INTO usage_events (id, account_id, funding, purpose, provider_id, model, status, hold_micros,
       markup_bps, fee_bps, charge_micros, created_at)
     VALUES (?, ?, 'pool', 'reply', 'openrouter', 'simple', ?, ?, 0, 0, ?, ?)`,
  )
    .bind(
      id,
      poolId,
      extra.status ?? 'pending',
      extra.holdMicros ?? 3_000,
      extra.chargeMicros ?? null,
      createdAt,
    )
    .run();
  return id;
}

/** Pool params for the meter, on a test pool. */
function params(poolId: string, overrides: Partial<PoolParams> = {}): PoolParams {
  return {
    ...BASE_PARAMS,
    accountId: poolId,
    caps: OPEN_CAPS,
    limits: OPEN_LIMITS,
    overage: NO_BREAKER,
    ...overrides,
  };
}

function registryOf(provider: LlmProvider): ProviderRegistry {
  const info: ProviderInfo = {
    id: provider.id,
    kind: provider.kind,
    label: provider.label,
    models: provider.models(),
    defaultModel: provider.defaultModel(),
    openModels: false,
    available: true,
    acceptsUserKey: false,
    keySource: 'server',
  };
  return {
    get: (id) => (id === provider.id ? provider : undefined),
    list: () => [info],
    defaultProviderId: () => provider.id,
  };
}

/** A built-in provider (`openrouter`) whose stream is the given generator. */
function providerOf(stream: (req: GenerateRequest) => AsyncIterable<ProviderEvent>): LlmProvider {
  return {
    id: 'openrouter',
    kind: 'fake',
    label: 'Tangent',
    models: () => [{ id: 'simple', label: 'Normal', tier: 'normal' }],
    defaultModel: () => 'simple',
    capabilities: () => ({
      maxContextTokens: 8192,
      maxOutputTokens: 2048,
      supportsSystemPrompt: true,
      supportsTokenCount: false,
      supportsWebSearch: false,
    }),
    stream,
  };
}

function tag(overrides: Partial<UsageTag> = {}): UsageTag {
  return {
    purpose: 'reply',
    treeId: 'tree_1',
    branchId: 'branch_1',
    nodeId: uniq('node'),
    ...overrides,
  };
}

function genRequest(t: UsageTag, signal = new AbortController().signal): GenerateRequest {
  return {
    model: 'simple',
    system: null,
    messages: [{ role: 'user', content: 'hi' }],
    maxOutputTokens: 2048,
    signal,
    usageTag: t,
  };
}

async function drain(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** Runs `deferred` work (and the work it defers) to completion. */
async function settleAll(deferred: Promise<unknown>[]): Promise<void> {
  for (let seen = -1; seen !== deferred.length;) {
    seen = deferred.length;
    await Promise.allSettled(deferred);
  }
}

describe('PoolBank: the never-negative invariant (spec test)', () => {
  it('lets exactly as many concurrent reservations through as the pool covers, then settles every one', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 50_000);
    const seen: number[] = [];
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        reserve(poolId).then(async (r) => {
          seen.push(await available(poolId));
          return r;
        }),
      ),
    );
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(16); // 16 × 3_000 ≤ 50_000 < 17 × 3_000
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'empty')).toBe(true);
    expect(seen.every((a) => a >= 0)).toBe(true);
    expect(await available(poolId)).toBe(2_000);

    // Settle half at random actual costs within the hold, release the rest.
    for (const [i, r] of ok.entries()) {
      if (!r.ok) continue;
      const settle =
        i % 2 === 0
          ? {
              costNanos: Math.floor(Math.random() * 3_000_000),
              markupBps: 0,
              feeBps: 0,
              reason: 'cost' as const,
            }
          : { costNanos: 0, markupBps: 0, feeBps: 0, reason: 'released' as const };
      expect((await settleUsage(env.DB, r.usageId, settle)).changed).toBe(true);
      expect(await available(poolId)).toBeGreaterThanOrEqual(0);
    }
    const rows = await poolRows(poolId);
    expect(rows).toHaveLength(16);
    expect(rows.every((r) => r.status === 'settled')).toBe(true);
    const charged = rows.reduce((sum, r) => sum + (r.charge_micros ?? 0), 0);
    expect(charged).toBeLessThanOrEqual(50_000);
    expect(await available(poolId)).toBe(50_000 - charged);
    expect(rows.filter((r) => r.settle_reason === 'released')).toHaveLength(8);
  });

  it('holds end to end through the metered registry: 20 concurrent streams on a small pool', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 20_000);
    const deferred: Promise<unknown>[] = [];
    const meter = createPoolUsageMeter(
      env,
      params(poolId),
      uniq('user'),
      (p) => deferred.push(p),
      FAST,
    );
    // The fake built-in provider of vitest.config.ts (reports 0.001234 USD per call), charged
    // with the fee and no pool markup: ceil(1234 × 1.055) = 1302 µ$.
    const inner = createProviderRegistry([simpleProviderConfig(env)], { secrets: {} });
    const registry = meteredRegistry(inner, meter, (id) => id === 'openrouter');
    const runs = await Promise.all(
      Array.from({ length: 20 }, () =>
        drain(registry.get('openrouter')!.stream(genRequest(tag()))),
      ),
    );
    await settleAll(deferred);
    const done = runs.filter((events) => events.at(-1)?.type === 'done');
    const refused = runs.filter((events) => events.at(-1)?.type === 'error');
    expect(done.length + refused.length).toBe(20);
    expect(refused.length).toBeGreaterThanOrEqual(5); // 20 × 1_302 > 20_000
    const rows = await poolRows(poolId);
    expect(rows).toHaveLength(done.length);
    expect(
      rows.every((r) => r.status === 'settled' && r.charge_micros === 1302 && r.markup_bps === 0),
    ).toBe(true);
    expect(await available(poolId)).toBe(20_000 - 1302 * done.length);
    expect(await available(poolId)).toBeGreaterThanOrEqual(0);
  });
});

describe('PoolBank: as shipped (wrangler.jsonc vars)', () => {
  it("reserves a new user's first pool reply within the daily caps", async () => {
    const shipped = { ...env, ...shippedVars(), POOL_ACCOUNT_ID: uniq('pool') } as AppEnv;
    const pool = await resolvePoolParams(shipped, 'ip-key');
    expect(pool.price).not.toBeNull();
    await fund(pool.accountId, 100_000_000);
    const result = await poolBank(shipped, pool.accountId).reserve(
      poolReserveRequest(pool, uniq('user'), {
        purpose: 'reply',
        treeId: 'tree_1',
        branchId: 'branch_1',
        nodeId: null,
        providerId: 'openrouter',
        holdMicros: replyCeilingMicros(pool, pool.price!),
        feeBps: pool.price!.feeBps,
      }),
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe('PoolBank: caps inside reserve', () => {
  it('refuses a user past their daily replies, with the reset and the cap', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 1_000_000);
    const userId = uniq('user');
    const caps: PoolCaps = { ...OPEN_CAPS, user: { requestsPerDay: 2, spendMicrosPerDay: 1e12 } };
    await reserved(poolId, { userId, caps });
    await reserved(poolId, { userId, caps });
    // Summaries and titles don't count as replies.
    await reserved(poolId, { userId, caps, purpose: 'summary' });
    await reserved(poolId, { userId, caps, purpose: 'title' });
    const refused = await reserve(poolId, { userId, caps });
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    expect(refused).toEqual({
      ok: false,
      reason: 'cap_requests',
      resetAt: tomorrow.toISOString(),
      limit: 2,
    });
    // A released reply (nothing was sent) gives the request back.
    const reply = (await poolRows(poolId)).find((r) => r.purpose === 'reply')!;
    await settleUsage(env.DB, reply.id, {
      costNanos: 0,
      markupBps: 0,
      feeBps: 0,
      reason: 'released',
    });
    expect((await reserve(poolId, { userId, caps })).ok).toBe(true);
  });

  it('refuses spend past the daily cap (settled charges plus pending holds)', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 1_000_000);
    const userId = uniq('user');
    const caps: PoolCaps = {
      ...OPEN_CAPS,
      user: { requestsPerDay: 100, spendMicrosPerDay: 5_000 },
    };
    const first = await reserved(poolId, { userId, caps });
    expect(await reserve(poolId, { userId, caps })).toMatchObject({
      ok: false,
      reason: 'cap_spend',
      limit: 5_000,
    });
    // Settling the first at 1_000 frees the rest of its hold.
    await settleUsage(env.DB, first, { costNanos: 1_000_000, markupBps: 0, feeBps: 0 });
    expect((await reserve(poolId, { userId, caps })).ok).toBe(true);
  });

  it('caps a network across users', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 1_000_000);
    const ipKey = uniq('ip');
    const caps: PoolCaps = { ...OPEN_CAPS, ip: { requestsPerDay: 2, spendMicrosPerDay: 1e12 } };
    await reserved(poolId, { ipKey, caps });
    await reserved(poolId, { ipKey, caps });
    expect(await reserve(poolId, { ipKey, caps })).toMatchObject({
      ok: false,
      reason: 'cap_ip',
      limit: 2,
    });
    expect((await reserve(poolId, { ipKey: uniq('ip'), caps })).ok).toBe(true);
    const spendCaps: PoolCaps = {
      ...OPEN_CAPS,
      ip: { requestsPerDay: 100, spendMicrosPerDay: 4_000 },
    };
    const other = uniq('ip');
    await reserved(poolId, { ipKey: other, caps: spendCaps });
    expect(await reserve(poolId, { ipKey: other, caps: spendCaps })).toMatchObject({
      ok: false,
      reason: 'cap_ip',
      limit: 4_000,
    });
  });

  it("caps everyone's spend together at a share of the day's base", async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 100_000);
    await fund(poolId, 900_000, new Date().toISOString()); // added today: in the day's base too
    const caps: PoolCaps = {
      ...OPEN_CAPS,
      global: { spendMicrosPerDay: 1e12, bpsOfMorningBalance: 100 },
    };
    // 9_000 of a 10_000 ceiling, by three different users.
    for (let i = 0; i < 3; i++) await reserved(poolId, { caps });
    expect(await reserve(poolId, { caps })).toMatchObject({
      ok: false,
      reason: 'cap_global',
      limit: 10_000,
    });
    // The fixed ceiling binds when it is lower.
    const low: PoolCaps = {
      ...OPEN_CAPS,
      global: { spendMicrosPerDay: 9_500, bpsOfMorningBalance: 10_000 },
    };
    expect(await reserve(poolId, { caps: low })).toMatchObject({
      ok: false,
      reason: 'cap_global',
      limit: 9_500,
    });
  });

  it('a pool empty at 00:00 UTC and funded later that day serves learners at once', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 1_000_000, new Date().toISOString());
    const caps: PoolCaps = {
      ...OPEN_CAPS,
      global: { spendMicrosPerDay: 1e12, bpsOfMorningBalance: 2_000 },
    };
    expect(await reserve(poolId, { caps })).toMatchObject({ ok: true });
    // 20% of the $1 added today.
    expect(await reserve(poolId, { caps, holdMicros: 200_000 })).toMatchObject({
      ok: false,
      reason: 'cap_global',
      limit: 200_000,
    });
  });

  it("counts rows from the retired member tier toward today's one ceiling", async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 1_000_000);
    const caps: PoolCaps = {
      ...OPEN_CAPS,
      global: { spendMicrosPerDay: 1e12, bpsOfMorningBalance: 100 }, // 10_000
    };
    // Rows reserved while the pool had tiers carry 'free' or 'member'; newer ones none.
    for (const tier of ['free', 'member'] as const) {
      const id = await reserved(poolId, { caps });
      await env.DB.prepare('UPDATE usage_events SET tier = ? WHERE id = ?').bind(tier, id).run();
    }
    await reserved(poolId, { caps }); // 9_000
    expect(await reserve(poolId, { caps })).toMatchObject({
      ok: false,
      reason: 'cap_global',
      limit: 10_000,
    });
  });

  it('applies the same caps whatever the caller holds: buying credit changes nothing', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 1_000_000);
    const userId = uniq('user');
    const caps: PoolCaps = { ...OPEN_CAPS, user: { requestsPerDay: 1, spendMicrosPerDay: 1e12 } };
    expect(await reserve(poolId, { userId, caps })).toMatchObject({ ok: true });
    expect(await reserve(poolId, { userId, caps })).toEqual({
      ok: false,
      reason: 'cap_requests',
      limit: 1,
      resetAt: expect.any(String),
    });
    await purchase(userId);
    expect(await reserve(poolId, { userId, caps })).toMatchObject({
      ok: false,
      reason: 'cap_requests',
      limit: 1,
    });
    // New rows carry no tier.
    expect((await poolRows(poolId)).map((r) => r.tier)).toEqual([null]);
  });

  it('refuses what the pool cannot cover as empty, and records the reservation row', async () => {
    quiet();
    const poolId = uniq('pool');
    expect(await reserve(poolId)).toEqual({
      ok: false,
      reason: 'empty',
      resetAt: null,
      limit: null,
    });
    await fund(poolId, 3_000);
    const userId = uniq('user');
    const id = await reserved(poolId, { userId, ipKey: 'ipk', nodeId: 'node_9' });
    expect(await usageRow(env, id)).toMatchObject({
      account_id: poolId,
      funding: 'pool',
      user_id: userId,
      ip_key: 'ipk',
      tier: null,
      tree_id: 'tree_1',
      branch_id: 'branch_1',
      node_id: 'node_9',
      status: 'pending',
      hold_micros: 3_000,
      markup_bps: 0,
    });
    expect(await reserve(poolId, { holdMicros: 1 })).toMatchObject({ ok: false, reason: 'empty' });
  });
});

describe('PoolBank: per-minute rate limits', () => {
  const MINUTE = 60_000;
  /** The start of a minute well inside today (the day caps stay out of the way). */
  const minuteStart = () => Math.floor(Date.now() / MINUTE) * MINUTE;

  it('counts replies per user and per network in fixed minutes; other calls ride free', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 1_000_000);
    const t = minuteStart();
    const limits: PoolRateLimits = { userPerMinute: 2, ipPerMinute: 3 };
    const [alice, bob, carol] = [uniq('user'), uniq('user'), uniq('user')];
    const at = (now: number, userId: string, extra: Partial<PoolReserveRequest> = {}) =>
      reserve(poolId, { userId, ipKey: 'net-a', limits, now, ...extra });

    expect((await at(t, alice)).ok).toBe(true);
    expect((await at(t + 1, alice)).ok).toBe(true);
    // Summaries and titles are part of an admitted reply.
    expect((await at(t + 2, alice, { purpose: 'summary' })).ok).toBe(true);
    expect((await at(t + 3, alice, { purpose: 'title' })).ok).toBe(true);
    expect(await at(t + 4, alice)).toMatchObject({
      ok: false,
      reason: 'rate',
      limit: 2,
      resetAt: new Date(t + MINUTE).toISOString(),
    });
    // The network has room for one more, from anyone on it.
    expect((await at(t + 5, bob)).ok).toBe(true);
    expect(await at(t + 6, carol)).toMatchObject({ ok: false, reason: 'rate', limit: 3 });
    // Another network, and the next minute, start from zero.
    expect((await at(t + 7, carol, { ipKey: 'net-b' })).ok).toBe(true);
    expect((await at(t + MINUTE, alice)).ok).toBe(true);
  });

  it('admit counts like a reply and refuses on the breaker too', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 1_000_000);
    const now = minuteStart();
    const userId = uniq('user');
    const limits: PoolRateLimits = { userPerMinute: 1, ipPerMinute: 10 };
    const admit = (overage = NO_BREAKER) =>
      poolBank(env, poolId).admit({ poolId, userId, ipKey: null, limits, overage, now });
    expect(await admit()).toEqual({ ok: true });
    expect(await admit()).toMatchObject({ ok: false, reason: 'rate', limit: 1 });
    expect(await reserve(poolId, { userId, limits, now })).toMatchObject({ reason: 'rate' });
    // A tripped breaker refuses before any counting.
    await insertPoolRow(poolId, new Date().toISOString(), { status: 'settled', chargeMicros: 0 });
    await env.DB.prepare(`UPDATE usage_events SET overage_micros = 500 WHERE account_id = ?`)
      .bind(poolId)
      .run();
    expect(
      await poolBank(env, poolId).admit({
        poolId,
        userId: uniq('user'),
        ipKey: null,
        limits,
        overage: { windowMs: DAY, maxMicros: 100 },
        now: now + 2 * MINUTE,
      }),
    ).toMatchObject({ ok: false, reason: 'unpriced' });
  });

  it('fails closed: a storage error refuses instead of admitting', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 1_000_000);
    await poolBank(env, poolId).failRateChecks(2);
    expect(await reserve(poolId)).toMatchObject({ ok: false, reason: 'rate' });
    expect(
      await poolBank(env, poolId).admit({
        poolId,
        userId: uniq('user'),
        ipKey: null,
        limits: OPEN_LIMITS,
        overage: NO_BREAKER,
      }),
    ).toMatchObject({ ok: false, reason: 'rate' });
    expect(await poolRows(poolId)).toEqual([]);
    expect((await reserve(poolId)).ok).toBe(true);
  });
});

describe('PoolBank: settlement clamp and the overage breaker', () => {
  it('clamps a pool charge to its hold and records the overage; a second settle changes nothing', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 10_000);
    const id = await reserved(poolId);
    const settle = { costNanos: 5_000_000, markupBps: 0, feeBps: 0 };
    expect(await settleUsage(env.DB, id, settle)).toEqual({ changed: true, clamped: true });
    expect(await usageRow(env, id)).toMatchObject({
      status: 'settled',
      charge_micros: 3_000,
      overage_micros: 2_000,
      settle_reason: 'cost',
    });
    expect(await settleUsage(env.DB, id, settle)).toEqual({ changed: false, clamped: false });
    expect(await available(poolId)).toBe(7_000);
  });

  it('refuses every reservation (unpriced) once overage in the window passes the threshold', async () => {
    quiet();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const poolId = uniq('pool');
    await fund(poolId, 1_000_000);
    const overage = { windowMs: DAY, maxMicros: 10_000 };
    // A provider whose real cost (0.01 USD) is far above the price table's hold.
    const pricey = providerOf(async function* () {
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } };
      yield { type: 'billing', costUsd: 0.01 };
      yield { type: 'done', stopReason: 'stop' };
    });
    const deferred: Promise<unknown>[] = [];
    const meter = createPoolUsageMeter(
      env,
      params(poolId, { overage }),
      uniq('user'),
      (p) => deferred.push(p),
      FAST,
    );
    const registry = meteredRegistry(registryOf(pricey), meter, () => true);
    for (let i = 0; i < 2; i++) {
      const events = await drain(registry.get('openrouter')!.stream(genRequest(tag())));
      expect(events.at(-1)?.type).toBe('done');
    }
    await settleAll(deferred);
    const rows = await poolRows(poolId);
    const total = rows.reduce((s, r) => s + r.overage_micros, 0);
    expect(total).toBeGreaterThan(10_000);
    expect(rows.every((r) => r.charge_micros === r.hold_micros)).toBe(true);
    // The breaker's sum is cached for a minute; a minute later it trips.
    expect(await reserve(poolId, { overage, now: Date.now() + 61_000 })).toMatchObject({
      ok: false,
      reason: 'unpriced',
      resetAt: null,
    });
    expect(error.mock.calls.some((c) => String(c[0]).includes('pool_breaker_tripped'))).toBe(true);
    // A higher threshold lets reservations through again.
    expect((await reserve(poolId, { now: Date.now() + 122_000 })).ok).toBe(true);
  });
});

describe('Pool meter', () => {
  it('shrinks the reply reservation to the exact worst case instead of reserving again', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 100_000);
    const p = params(poolId);
    const ceiling = replyCeilingMicros(p, p.price!);
    const reservationId = await reserved(poolId, {
      holdMicros: ceiling,
      feeBps: p.price!.feeBps,
    });
    const deferred: Promise<unknown>[] = [];
    const meter = createPoolUsageMeter(env, p, uniq('user'), (x) => deferred.push(x), FAST);
    const inner = createProviderRegistry([simpleProviderConfig(env)], { secrets: {} });
    const registry = meteredRegistry(inner, meter, () => true);
    let pending: UsageRow | null = null;
    const events: ProviderEvent[] = [];
    for await (const e of registry.get('openrouter')!.stream(genRequest(tag({ reservationId })))) {
      events.push(e);
      if (e.type === 'delta' && !pending) pending = await usageRow(env, reservationId);
    }
    await settleAll(deferred);
    expect(events.at(-1)?.type).toBe('done');
    // (2 bytes + 4 + 16) in + 2_048 out at 1 µ$ each, × 1.055 (fee); no pool markup.
    expect(pending).toMatchObject({
      status: 'pending',
      hold_micros: Math.ceil(2070 * 1.055),
    });
    expect(pending!.hold_micros).toBeLessThan(ceiling);
    expect(pending!.dispatched_at).not.toBeNull();
    const rows = await poolRows(poolId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: reservationId,
      status: 'settled',
      charge_micros: 1302,
      settle_reason: 'cost',
    });
  });

  it('never lets a second call claim, or release, a reservation another call has dispatched', async () => {
    quiet();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const poolId = uniq('pool');
    await fund(poolId, 100_000);
    const p = params(poolId);
    const ceiling = replyCeilingMicros(p, p.price!);
    const reservationId = await reserved(poolId, {
      holdMicros: ceiling,
      feeBps: p.price!.feeBps,
    });
    // Run A has dispatched the reservation and is still streaming upstream.
    await markDispatched(env.DB, reservationId);
    let calls = 0;
    const provider = providerOf(async function* () {
      calls++;
      yield { type: 'done', stopReason: 'stop' };
    });
    const deferred: Promise<unknown>[] = [];
    const meter = createPoolUsageMeter(env, p, uniq('user'), (x) => deferred.push(x), FAST);
    const events = await drain(
      meteredRegistry(registryOf(provider), meter, () => true)
        .get('openrouter')!
        .stream(genRequest(tag({ reservationId }))),
    );
    await settleAll(deferred);
    expect(events).toMatchObject([{ type: 'error', error: { upstream: 'not_sent' } }]);
    expect(calls).toBe(0);
    const row = await usageRow(env, reservationId);
    expect(row).toMatchObject({ status: 'pending', hold_micros: ceiling, charge_micros: null });
    expect(row.dispatched_at).not.toBeNull();
  });

  it('fails a call whose reservation is gone, without calling upstream', async () => {
    quiet();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const poolId = uniq('pool');
    let calls = 0;
    const provider = providerOf(async function* () {
      calls++;
      yield { type: 'done', stopReason: 'stop' };
    });
    const meter = createPoolUsageMeter(env, params(poolId), uniq('user'), () => undefined, FAST);
    const registry = meteredRegistry(registryOf(provider), meter, () => true);
    const events = await drain(
      registry.get('openrouter')!.stream(genRequest(tag({ reservationId: 'nope' }))),
    );
    expect(events).toMatchObject([{ type: 'error', error: { upstream: 'not_sent' } }]);
    // A refused reservation fails the same way.
    const refused = await drain(registry.get('openrouter')!.stream(genRequest(tag())));
    expect(refused).toMatchObject([
      { type: 'error', error: { code: 'server', retryable: false, upstream: 'not_sent' } },
    ]);
    expect(calls).toBe(0);
  });

  it('charges the full hold for a cancel after dispatch, before the first chunk', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 100_000);
    const waits = providerOf(async function* (req) {
      await new Promise((r) => req.signal.addEventListener('abort', r));
      yield {
        type: 'error',
        error: { code: 'aborted', message: 'Request aborted', retryable: false },
      };
    });
    const deferred: Promise<unknown>[] = [];
    const meter = createPoolUsageMeter(
      env,
      params(poolId),
      uniq('user'),
      (p) => deferred.push(p),
      FAST,
    );
    const registry = meteredRegistry(registryOf(waits), meter, () => true);
    const ac = new AbortController();
    const run = drain(registry.get('openrouter')!.stream(genRequest(tag(), ac.signal)));
    await vi.waitFor(async () => {
      const [row] = await poolRows(poolId);
      expect(row?.dispatched_at).toBeTruthy();
    });
    ac.abort();
    expect((await run).at(-1)).toMatchObject({ type: 'error', error: { code: 'aborted' } });
    await settleAll(deferred);
    const [row] = await poolRows(poolId);
    expect(row).toMatchObject({ status: 'settled', settle_reason: 'hold' });
    expect(row!.charge_micros).toBe(row!.hold_micros);
  });

  it('releases at 0 when the upstream rejects the call, and settles observed tokens without a cost', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 100_000);
    const rejects = providerOf(async function* () {
      yield {
        type: 'error',
        error: {
          code: 'rate_limit',
          message: 'busy',
          status: 429,
          retryable: true,
          upstream: 'rejected',
        },
      };
    });
    const tokensOnly = providerOf(async function* () {
      yield { type: 'delta', text: 'x' };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } };
      yield { type: 'done', stopReason: 'stop' };
    });
    const deferred: Promise<unknown>[] = [];
    const p = params(poolId);
    for (const provider of [rejects, tokensOnly]) {
      const meter = createPoolUsageMeter(env, p, uniq('user'), (x) => deferred.push(x), FAST);
      await drain(
        meteredRegistry(registryOf(provider), meter, () => true)
          .get('openrouter')!
          .stream(genRequest(tag())),
      );
    }
    await settleAll(deferred);
    const [rejected, priced] = await poolRows(poolId);
    expect(rejected).toMatchObject({
      status: 'settled',
      charge_micros: 0,
      settle_reason: 'released',
    });
    // 150 tokens at 1 µ$, × 1.055 (fee) = 158.25 → 159; no pool markup.
    expect(priced).toMatchObject({
      status: 'settled',
      charge_micros: 159,
      settle_reason: 'tokens',
      cost_nanos: 150_000,
    });
    expect(await available(poolId)).toBe(100_000 - 159);
  });

  it('settles observed tokens at the cache prices the stream reports', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 100_000);
    const base = params(poolId);
    // 1 µ$ per token in and out (the test price), reads 0.1×, writes 1.25×.
    expect(base.price).toMatchObject({ inMicrosPerMTok: 1_000_000, outMicrosPerMTok: 1_000_000 });
    const p = params(poolId, {
      price: {
        ...base.price!,
        cacheReadMicrosPerMTok: 100_000,
        cacheWriteMicrosPerMTok: 1_250_000,
      },
    });
    const cached = providerOf(async function* () {
      yield { type: 'delta', text: 'x' };
      yield {
        type: 'usage',
        usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100 },
      };
      yield { type: 'done', stopReason: 'stop' };
    });
    const deferred: Promise<unknown>[] = [];
    const meter = createPoolUsageMeter(env, p, uniq('user'), (x) => deferred.push(x), FAST);
    await drain(
      meteredRegistry(registryOf(cached), meter, () => true)
        .get('openrouter')!
        .stream(genRequest(tag())),
    );
    await settleAll(deferred);
    const [row] = await poolRows(poolId);
    // 800 × 0.1 + 100 × 1.25 + 100 × 1 + 50 × 1 = 355 µ$; × 1.055 (fee) = 374.5 → 375.
    expect(row).toMatchObject({
      status: 'settled',
      settle_reason: 'tokens',
      cost_nanos: 355_000,
      charge_micros: 375,
    });
  });
});

describe('PoolBank: reservation expiry (spec test)', () => {
  it('releases undispatched reservations past the TTL and charges dispatched ones', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 100_000);
    const stub = poolBank(env, poolId);
    const idle = await reserved(poolId);
    const lost = await reserved(poolId);
    await markDispatched(env.DB, lost);
    const failing = await reserved(poolId);
    await markDispatched(env.DB, failing);
    const genFail = uniq('gen-fail');
    await setGenerationId(env.DB, failing, genFail);
    await scriptGeneration(genFail, [{ status: 500, body: { error: { message: 'down' } } }]);
    const found = await reserved(poolId);
    await markDispatched(env.DB, found);
    const genOk = uniq('gen-ok');
    await setGenerationId(env.DB, found, genOk);
    await scriptGeneration(genOk, [{ costUsd: 0.002, inputTokens: 10, outputTokens: 20 }]);
    const young = await reserved(poolId);
    expect(await available(poolId)).toBe(100_000 - 5 * 3_000);

    // Not yet expired: nothing happens.
    expect(await stub.expire(Date.now())).toEqual({
      released: 0,
      charged: 0,
      deferred: 0,
      more: false,
    });

    const later = Date.now() + TTL + 1_000;
    // Reserved later than the others: not yet expired at `later`.
    await env.DB.prepare('UPDATE usage_events SET created_at = ? WHERE id = ?')
      .bind(new Date(later - TTL + MIN).toISOString(), young)
      .run();
    const result = await stub.expire(later);
    expect(result).toEqual({ released: 1, charged: 2, deferred: 1, more: false });
    expect(await usageRow(env, idle)).toMatchObject({
      status: 'settled',
      charge_micros: 0,
      settle_reason: 'released',
    });
    expect(await usageRow(env, lost)).toMatchObject({
      status: 'settled',
      charge_micros: 3_000,
      settle_reason: 'hold',
    });
    // 2_000 µ$ reported, clamped to the hold.
    expect(await usageRow(env, found)).toMatchObject({
      status: 'settled',
      charge_micros: 2_000,
      settle_reason: 'generation',
      input_tokens: 10,
      output_tokens: 20,
    });
    expect((await usageRow(env, failing)).status).toBe('pending');

    // Past the give-up age, the failing lookup gives way to the full hold.
    const giveUp = await stub.expire(Date.now() + GIVE_UP + 1_000);
    expect(giveUp).toMatchObject({ charged: 1, deferred: 0 });
    expect(await usageRow(env, failing)).toMatchObject({
      status: 'settled',
      settle_reason: 'hold',
      charge_micros: 3_000,
    });
    // The young reservation expires too by then (it was never dispatched).
    expect(await usageRow(env, young)).toMatchObject({
      status: 'settled',
      settle_reason: 'released',
    });
    expect(await available(poolId)).toBe(100_000 - 3_000 - 2_000 - 3_000);
  });

  it('charges an expired call its cost with the row’s fee, and no markup', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 100_000);
    const stub = poolBank(env, poolId);
    const found = await reserved(poolId, { holdMicros: 5_000, feeBps: 550 });
    await markDispatched(env.DB, found);
    const gen = uniq('gen-ok');
    await setGenerationId(env.DB, found, gen);
    await scriptGeneration(gen, [{ costUsd: 0.002, inputTokens: 10, outputTokens: 20 }]);
    await stub.expire(Date.now() + TTL + 1_000);
    // The pool pays the true cost: 2_000 µ$ × 1.055 = 2_110.
    expect(await usageRow(env, found)).toMatchObject({
      status: 'settled',
      settle_reason: 'generation',
      markup_bps: 0,
      fee_bps: 550,
      charge_micros: 2_110,
    });
  });

  it('runs from the alarm and re-arms while expired rows remain', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 100_000);
    const stub = poolBank(env, poolId);
    // The first pass runs at a clock past the TTL, well before the alarm
    // (due at the TTL) could race it; the alarm then runs at the real clock.
    const expiry = { ttlMs: 2_000, giveUpMs: GIVE_UP, batch: 2 };
    for (let i = 0; i < 5; i++) await reserved(poolId, { expiry });
    expect((await stub.status()).alarm).not.toBeNull();
    // One pass settles a batch and asks to come back right away.
    const first = await stub.expire(Date.now() + 5_000);
    expect(first).toMatchObject({ released: 2, more: true });
    const alarm = (await stub.status()).alarm;
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(Date.now() + 1_000);
    // The alarm finishes the job.
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(stub);
        const rows = await poolRows(poolId);
        expect(rows.every((r) => r.status === 'settled')).toBe(true);
      },
      { timeout: 10_000, interval: 200 },
    );
    expect(await available(poolId)).toBe(100_000);
    expect((await stub.status()).alarm).toBeNull();
  });

  it('never blocks a reservation behind slow generation lookups', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 1_000_000);
    const stub = poolBank(env, poolId);
    for (let i = 0; i < 50; i++) {
      const id = await reserved(poolId);
      await markDispatched(env.DB, id);
      const gen = uniq('gen-slow');
      await setGenerationId(env.DB, id, gen);
      await scriptGeneration(gen, [{ status: 404, delayMs: 2_000 }]);
    }
    const pass = stub.expire(Date.now() + TTL + 1_000);
    await sleep(100);
    const started = Date.now();
    expect((await reserve(poolId)).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    // A bounded batch of lookups, one attempt each; the rest wait for the re-armed alarm.
    expect(await pass).toEqual({ released: 0, charged: 0, deferred: 20, more: false });
    expect((await stub.status()).alarm).not.toBeNull();
  }, 20_000);

  it('never releases a reservation dispatched between its read and its settle', async () => {
    quiet();
    const poolId = uniq('pool');
    await fund(poolId, 100_000);
    const id = await reserved(poolId);
    // The meter stamps the dispatch right after expiry read the row as undispatched.
    let raced = false;
    const db = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver) as unknown;
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (raced || !sql.includes("SET status = 'settled'")) return stmt;
          raced = true;
          return new Proxy(stmt, {
            get(st, p, r) {
              if (p !== 'bind') return Reflect.get(st, p, r) as unknown;
              return (...args: unknown[]) => {
                const bound = st.bind(...args);
                return new Proxy(bound, {
                  get(b, q, rb) {
                    if (q !== 'first') return Reflect.get(b, q, rb) as unknown;
                    return async () => {
                      expect(await markDispatched(target, id)).toBe(true);
                      return b.first();
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
    const result = await expirePoolReservations(
      { ...env, DB: db },
      poolId,
      new Date(Date.now() + TTL + 1_000),
      { ttlMs: TTL, giveUpMs: GIVE_UP, batch: 20 },
    );
    expect(raced).toBe(true);
    expect(result).toEqual({ released: 0, charged: 0, deferred: 1, more: false });
    const row = await usageRow(env, id);
    expect(row.status).toBe('pending');
    expect(row.dispatched_at).not.toBeNull();
    // The in-flight call still settles at its cost.
    const settle = { costNanos: 1_000_000, markupBps: 0, feeBps: 0 };
    expect((await settleUsage(env.DB, id, settle)).changed).toBe(true);
    expect(await usageRow(env, id)).toMatchObject({ status: 'settled', charge_micros: 1_000 });
  });

  it('refuses to dispatch a reservation too close to its TTL, without calling upstream', async () => {
    quiet();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const poolId = uniq('pool');
    await fund(poolId, 100_000);
    const p = params(poolId);
    const id = await reserved(poolId);
    await env.DB.prepare('UPDATE usage_events SET created_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - (p.ttlMs - p.callTimeoutMs) - 1_000).toISOString(), id)
      .run();
    let calls = 0;
    const provider = providerOf(async function* () {
      calls++;
      yield { type: 'done', stopReason: 'stop' };
    });
    const deferred: Promise<unknown>[] = [];
    const meter = createPoolUsageMeter(env, p, uniq('user'), (x) => deferred.push(x), FAST);
    const events = await drain(
      meteredRegistry(registryOf(provider), meter, () => true)
        .get('openrouter')!
        .stream(genRequest(tag({ reservationId: id }))),
    );
    await settleAll(deferred);
    expect(events).toMatchObject([{ type: 'error', error: { upstream: 'not_sent' } }]);
    expect(calls).toBe(0);
    expect(await usageRow(env, id)).toMatchObject({
      status: 'settled',
      charge_micros: 0,
      settle_reason: 'released',
      dispatched_at: null,
    });
  });

  it('is backstopped by the cron, for every pool with stale reservations', async () => {
    quiet();
    const NOW = new Date('2011-03-01T12:00:00.000Z');
    const poolA = uniq('pool');
    const poolB = uniq('pool');
    const old = new Date(NOW.getTime() - TTL - MIN).toISOString();
    const a = await insertPoolRow(poolA, old);
    const b = await insertPoolRow(poolB, old);
    const fresh = await insertPoolRow(poolB, new Date(NOW.getTime() - MIN).toISOString());
    // Dispatched with no generation id: the full hold.
    const lost = await insertPoolRow(poolA, old);
    await markDispatched(env.DB, lost, new Date(old));
    // Dispatched with a generation id: the looked-up cost.
    const found = await insertPoolRow(poolB, old);
    await markDispatched(env.DB, found, new Date(old));
    const genOk = uniq('gen-ok');
    await setGenerationId(env.DB, found, genOk);
    await scriptGeneration(genOk, [{ costUsd: 0.002, inputTokens: 10, outputTokens: 20 }]);
    const result = await reconcilePoolUsage(env, NOW);
    expect(result[poolA]).toMatchObject({ released: 1, charged: 1 });
    expect(result[poolB]).toMatchObject({ released: 1, charged: 1 });
    expect(await usageRow(env, a)).toMatchObject({ status: 'settled', settle_reason: 'released' });
    expect(await usageRow(env, b)).toMatchObject({ status: 'settled', settle_reason: 'released' });
    expect(await usageRow(env, lost)).toMatchObject({
      status: 'settled',
      settle_reason: 'hold',
      charge_micros: 3_000,
    });
    expect(await usageRow(env, found)).toMatchObject({
      status: 'settled',
      settle_reason: 'generation',
      charge_micros: 2_000,
    });
    expect((await usageRow(env, fresh)).status).toBe('pending');
    await settleUsage(env.DB, fresh, { costNanos: 0, markupBps: 0, feeBps: 0, reason: 'released' });
  });
});

describe('PoolBank: balance checkpoint', () => {
  it('advances over immutable rows, sums the same as the full ledger, and serves reservations', async () => {
    quiet();
    const poolId = uniq('pool');
    const stub = poolBank(env, poolId);
    await fund(poolId, 50_000, '2020-01-01T00:00:00.000Z');
    await insertPoolRow(poolId, '2020-01-02T00:00:00.000Z', {
      status: 'settled',
      chargeMicros: 7_000,
    });
    await insertPoolRow(poolId, '2020-01-02T00:00:00.000Z', { status: 'settled', chargeMicros: 0 });
    await fund(poolId, 5_000, new Date().toISOString());
    const now = Date.now();
    const result = await stub.maintain({ poolId, giveUpMs: GIVE_UP, now });
    expect(result).toMatchObject({ advanced: true, mismatchMicros: 0 });
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    expect(result.checkpoint!.at).toBe(
      new Date(Math.min(now - 2 * GIVE_UP, today.getTime())).toISOString(),
    );
    expect(result.checkpoint!.balanceMicros).toBe(43_000);
    expect(await getBalance(env.DB, poolId, result.checkpoint)).toEqual(
      await getBalance(env.DB, poolId),
    );

    // Reservations read the checkpoint plus newer rows: 48_000 available (the open caps'
    // global share of the morning balance doesn't bind first).
    const userId = uniq('user');
    expect(await reserve(poolId, { userId, holdMicros: 48_001 })).toMatchObject({
      ok: false,
      reason: 'empty',
    });
    expect((await reserve(poolId, { userId, holdMicros: 48_000 })).ok).toBe(true);
    // Verified once a day: a second run neither advances nor re-verifies.
    expect(await stub.maintain({ poolId, giveUpMs: GIVE_UP, now })).toMatchObject({
      advanced: false,
      mismatchMicros: null,
    });
  });

  it('does not advance past a reservation that is still pending', async () => {
    quiet();
    const poolId = uniq('pool');
    const stub = poolBank(env, poolId);
    await fund(poolId, 50_000);
    const stale = await insertPoolRow(poolId, '2020-01-02T00:00:00.000Z');
    expect(await stub.maintain({ poolId, giveUpMs: GIVE_UP })).toMatchObject({
      advanced: false,
      checkpoint: null,
    });
    expect((await stub.status()).checkpoint).toBeNull();
    await settleUsage(env.DB, stale, { costNanos: 0, markupBps: 0, feeBps: 0, reason: 'released' });
    expect(await stub.maintain({ poolId, giveUpMs: GIVE_UP })).toMatchObject({ advanced: true });
  });
});

describe('Personal reconciliation beside the pool', () => {
  it('is never starved by a backlog of pool reservations', async () => {
    quiet();
    // Its own era: no other test's rows are this old, or pending.
    const NOW = new Date('2010-01-01T12:00:00.000Z');
    const poolId = uniq('pool');
    const statements = Array.from({ length: 250 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO usage_events (id, account_id, funding, purpose, provider_id, model, status, hold_micros,
           markup_bps, fee_bps, created_at)
         VALUES (?, ?, 'pool', 'reply', 'openrouter', 'simple', 'pending', 3000, 0, 0, ?)`,
      ).bind(uniq('use'), poolId, new Date(NOW.getTime() - 30 * MIN + i).toISOString()),
    );
    await env.DB.batch(statements);
    const personal = uniq('use');
    await env.DB.prepare(
      `INSERT INTO usage_events (id, account_id, purpose, provider_id, model, status, hold_micros,
         markup_bps, fee_bps, created_at)
       VALUES (?, ?, 'reply', 'openrouter', 'smart', 'pending', 20000, 1000, 550, ?)`,
    )
      .bind(personal, `u_${uniq('user')}`, new Date(NOW.getTime() - 15 * MIN).toISOString())
      .run();
    expect(await reconcilePendingUsage(env, NOW)).toEqual({ settled: 1, unresolved: 0 });
    expect(await usageRow(env, personal)).toMatchObject({
      status: 'settled',
      settle_reason: 'released',
    });
    expect((await poolRows(poolId)).every((r) => r.status === 'pending')).toBe(true);
    // Leave nothing pending for other suites' crons.
    await env.DB.prepare(
      "UPDATE usage_events SET status = 'settled', charge_micros = 0, settle_reason = 'released' WHERE account_id = ?",
    )
      .bind(poolId)
      .run();
  });
});
