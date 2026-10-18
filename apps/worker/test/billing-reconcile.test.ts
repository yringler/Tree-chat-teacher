import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcileGeneration, reconcilePendingUsage } from '../src/billing/reconcile.js';
import { markDispatched, settleUsage } from '../src/billing/usage-store.js';
import { builtInApiKey } from '../src/simple-mode.js';
import { CRON_JOBS } from '../src/cron.js';
import type { AppEnv } from '../src/env.js';
import {
  generationCalls,
  insertUsage,
  scriptGeneration,
  uniq,
  usageRow,
} from './mocks/billing-helpers.js';

const env = { ...(rawEnv as unknown as AppEnv), BUILT_IN_API_KEY: 'sk-or-cron' } as AppEnv;

/**
 * A fixed clock in the past: every row other tests create (stamped with the
 * real clock) is newer than it, so the cron only ever sees this file's rows.
 */
const NOW = new Date('2020-06-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usage reconciliation cron', () => {
  it('settles stale rows, zeroes id-less ones and gives up after 24 h', async () => {
    const accountId = uniq('acct');
    const genOk = uniq('gen-ok');
    const genLate = uniq('gen-late');
    const genLost = uniq('gen-lost');
    const genFresh = uniq('gen-fresh');
    await scriptGeneration(genOk, [{ costUsd: 0.01, inputTokens: 5, outputTokens: 6 }]);

    const withId = await insertUsage(env, {
      accountId,
      generationId: genOk,
      createdAt: ago(5 * MIN),
      markupBps: 500,
      feeBps: 200, // the fee in force when the call started, not today's 550
    });
    const notYet = await insertUsage(env, {
      accountId,
      generationId: genLate,
      createdAt: ago(5 * MIN),
    });
    const lost = await insertUsage(env, {
      accountId,
      generationId: genLost,
      createdAt: ago(25 * HOUR),
    });
    const fresh = await insertUsage(env, {
      accountId,
      generationId: genFresh,
      createdAt: ago(1 * MIN),
    });
    const noIdOld = await insertUsage(env, { accountId, createdAt: ago(15 * MIN) });
    const noIdYoung = await insertUsage(env, { accountId, createdAt: ago(5 * MIN) });
    const done = await insertUsage(env, {
      accountId,
      status: 'settled',
      chargeMicros: 7,
      createdAt: ago(48 * HOUR),
    });

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await reconcilePendingUsage(env, NOW);
    expect(result).toEqual({ settled: 2, unresolved: 1 });

    expect(await usageRow(env, withId)).toMatchObject({
      status: 'settled',
      cost_nanos: 10_000_000,
      fee_bps: 200,
      charge_micros: 10_710, // 10_000 × 1.02 × 1.05
      input_tokens: 5,
      output_tokens: 6,
      settled_at: NOW.toISOString(),
    });
    expect(await usageRow(env, notYet)).toMatchObject({ status: 'pending', charge_micros: null });
    expect(await usageRow(env, lost)).toMatchObject({ status: 'unresolved', charge_micros: 0 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"event":"usage_unresolved"'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`"usageId":"${lost}"`));
    expect(await usageRow(env, fresh)).toMatchObject({ status: 'pending' });
    expect((await generationCalls(genFresh)).count).toBe(0);
    expect(await usageRow(env, noIdOld)).toMatchObject({
      status: 'settled',
      cost_nanos: 0,
      charge_micros: 0,
    });
    expect(await usageRow(env, noIdYoung)).toMatchObject({ status: 'pending' });
    expect(await usageRow(env, done)).toMatchObject({ status: 'settled', charge_micros: 7 });
    expect((await generationCalls(genOk)).authorizations).toEqual(['Bearer sk-or-cron']);

    // A second run is a no-op for everything already resolved.
    expect(await reconcilePendingUsage(env, NOW)).toEqual({ settled: 0, unresolved: 0 });
  });

  it('counts one search for reported results, and keeps the stored count for none', async () => {
    const accountId = uniq('acct');
    const row = async (results: number) => {
      const generationId = uniq('gen-search');
      await scriptGeneration(generationId, [{ costUsd: 0.001, numSearchResults: results }]);
      const id = await insertUsage(env, { accountId, generationId, createdAt: ago(5 * MIN) });
      await env.DB.prepare('UPDATE usage_events SET web_searches = 3 WHERE id = ?').bind(id).run();
      return id;
    };
    const none = await row(0);
    const five = await row(5);
    await reconcilePendingUsage(env, NOW);
    expect(await usageRow(env, none)).toMatchObject({ status: 'settled', web_searches: 3 });
    expect(await usageRow(env, five)).toMatchObject({ status: 'settled', web_searches: 1 });
  });

  it('settles a cancelled generation at what OpenRouter reports, $0 included', async () => {
    const generationId = uniq('gen-cancelled');
    await scriptGeneration(generationId, [{ costUsd: 0, cancelled: true }]);
    const id = await insertUsage(env, {
      accountId: uniq('acct'),
      generationId,
      createdAt: ago(5 * MIN),
    });
    await reconcilePendingUsage(env, NOW);
    expect(await usageRow(env, id)).toMatchObject({
      status: 'settled',
      settle_reason: 'generation',
      cost_nanos: 0,
      charge_micros: 0,
    });
  });

  it("settles inline with the stream's own search count over OpenRouter's results", async () => {
    const generationId = uniq('gen-inline');
    await scriptGeneration(generationId, [{ costUsd: 0.001, numSearchResults: 5 }]);
    const id = await insertUsage(env, { accountId: uniq('acct'), generationId });
    const target = { usageId: id, markupBps: 0, feeBps: 0, webSearches: 2 };
    expect(await reconcileGeneration(env, target, generationId, { delaysMs: [0] })).toBe(true);
    expect(await usageRow(env, id)).toMatchObject({
      status: 'settled',
      settle_reason: 'generation',
      charge_micros: 1_000,
      web_searches: 2,
    });
  });

  it('survives OpenRouter errors and still gives up on old rows without a key', async () => {
    const accountId = uniq('acct');
    const genErr = uniq('gen-err');
    await scriptGeneration(genErr, [{ status: 500, body: { error: 'boom' } }]);
    const erroring = await insertUsage(env, {
      accountId,
      generationId: genErr,
      createdAt: ago(3 * MIN),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await reconcilePendingUsage(env, NOW);
    expect(await usageRow(env, erroring)).toMatchObject({ status: 'pending' });

    const noKey = { ...env, BUILT_IN_API_KEY: '' } as AppEnv;
    const old = await insertUsage(env, {
      accountId,
      generationId: uniq('gen'),
      createdAt: ago(30 * HOUR),
    });
    await reconcilePendingUsage(noKey, NOW);
    expect(await usageRow(env, old)).toMatchObject({ status: 'unresolved', charge_micros: 0 });
  });

  it('resolves the OpenRouter key from BUILT_IN_PROVIDER or BUILT_IN_API_KEY', () => {
    expect(builtInApiKey({ ...env, BUILT_IN_PROVIDER: '' } as AppEnv)).toBe('sk-or-cron');
    expect(builtInApiKey({ ...env, BUILT_IN_API_KEY: '' } as AppEnv)).toBeNull();
    const named = {
      ...env,
      BUILT_IN_PROVIDER: JSON.stringify({ id: 'openrouter', apiKeySecret: 'OTHER_KEY' }),
      OTHER_KEY: ' sk-other ',
    } as AppEnv;
    expect(builtInApiKey(named)).toBe('sk-other');
    expect(builtInApiKey({ ...env, BUILT_IN_PROVIDER: '{bad json' } as AppEnv)).toBe('sk-or-cron');
  });

  it('runs as the cron job at the time the trigger gives it', async () => {
    // Five minutes old at NOW: too young to give up on, whatever today's date.
    const young = await insertUsage(env, { accountId: uniq('acct'), createdAt: ago(5 * MIN) });
    await CRON_JOBS.reconcile(env, NOW);
    expect(await usageRow(env, young)).toMatchObject({ status: 'pending' });
  });
});

describe('usage reconciliation cron: a call whose meter died without a generation id', () => {
  /** `max` at $150 in, $600 out per million tokens. */
  const PRICED = {
    ...env,
    MODEL_PRICES: JSON.stringify({ max: { in: 150_000_000, out: 600_000_000, context: 200_000 } }),
  } as AppEnv;
  const stale = { createdAt: ago(15 * MIN), holdMicros: 400_000, markupBps: 500, feeBps: 200 };

  it('releases a call never sent at $0, whatever its estimate', async () => {
    const id = await insertUsage(env, { accountId: uniq('acct'), ...stale, heldInputTokens: 1000 });
    expect(await reconcilePendingUsage(PRICED, NOW)).toEqual({ settled: 1, unresolved: 0 });
    expect(await usageRow(env, id)).toMatchObject({
      status: 'settled',
      settle_reason: 'released',
      cost_nanos: 0,
      charge_micros: 0,
    });
  });

  it('charges a sent call the input its hold was sized with, at the input price, with no output', async () => {
    const id = await insertUsage(env, {
      accountId: uniq('acct'),
      ...stale,
      dispatchedAt: ago(15 * MIN),
      heldInputTokens: 1000,
    });
    expect(await reconcilePendingUsage(PRICED, NOW)).toEqual({ settled: 1, unresolved: 0 });
    expect(await usageRow(env, id)).toMatchObject({
      status: 'settled',
      settle_reason: 'tokens',
      // 1000 × $150 / M = 150_000 µ$, at the row's own fee and markup: × 1.02 × 1.05.
      cost_nanos: 150_000_000,
      charge_micros: 160_650,
      settled_at: NOW.toISOString(),
    });
  });

  it('charges a sent call its hold when its row has no estimate', async () => {
    const id = await insertUsage(env, {
      accountId: uniq('acct'),
      ...stale,
      dispatchedAt: ago(15 * MIN),
    });
    expect(await reconcilePendingUsage(PRICED, NOW)).toEqual({ settled: 1, unresolved: 0 });
    expect(await usageRow(env, id)).toMatchObject({
      status: 'settled',
      settle_reason: 'hold',
      charge_micros: 400_000,
    });
  });

  it('settles a sent call with a generation id from its lookup, as before', async () => {
    const generationId = uniq('gen-sent');
    await scriptGeneration(generationId, [{ costUsd: 0.01, inputTokens: 5, outputTokens: 6 }]);
    const id = await insertUsage(env, {
      accountId: uniq('acct'),
      ...stale,
      generationId,
      dispatchedAt: ago(15 * MIN),
      heldInputTokens: 1000,
    });
    expect(await reconcilePendingUsage(PRICED, NOW)).toEqual({ settled: 1, unresolved: 0 });
    expect(await usageRow(env, id)).toMatchObject({
      status: 'settled',
      settle_reason: 'generation',
      cost_nanos: 10_000_000,
      charge_micros: 10_710,
    });
  });

  it('leaves a row its meter settled after the cron read it, and never releases one sent since', async () => {
    const accountId = uniq('acct');
    const settledByMeter = await insertUsage(env, {
      accountId,
      ...stale,
      dispatchedAt: ago(15 * MIN),
      heldInputTokens: 1000,
    });
    const sentSince = await insertUsage(env, { accountId, ...stale, heldInputTokens: 1000 });
    const racing = afterSelect(PRICED, async () => {
      await settleUsage(env.DB, settledByMeter, {
        costNanos: 1_000_000,
        markupBps: 0,
        feeBps: 0,
        reason: 'cost',
      });
      expect(await markDispatched(env.DB, sentSince)).toBe(true);
    });
    expect(await reconcilePendingUsage(racing, NOW)).toEqual({ settled: 0, unresolved: 0 });
    expect(await usageRow(env, settledByMeter)).toMatchObject({
      settle_reason: 'cost',
      charge_micros: 1_000,
    });
    expect(await usageRow(env, sentSince)).toMatchObject({ status: 'pending' });
  });
});

/**
 * `env` whose D1 runs `hook` once, right after the first SELECT's rows are
 * read: another writer acting between the cron's read and its settle.
 */
function afterSelect(base: AppEnv, hook: () => Promise<void>): AppEnv {
  let ran = false;
  const passThrough = <T extends object>(target: T, prop: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, prop);
    return typeof value === 'function'
      ? (value as (...a: unknown[]) => unknown).bind(target)
      : value;
  };
  const statement = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => statement(target.bind(...values));
        if (prop === 'all')
          return async () => {
            const result = await target.all();
            if (!ran) {
              ran = true;
              await hook();
            }
            return result;
          };
        return passThrough(target, prop);
      },
    });
  const DB = new Proxy(base.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const stmt = target.prepare(sql);
          return sql.trimStart().startsWith('SELECT') ? statement(stmt) : stmt;
        };
      return passThrough(target, prop);
    },
  });
  return { ...base, DB };
}
