import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcilePendingUsage, simpleApiKey } from '../src/billing/reconcile.js';
import { CRON_JOBS } from '../src/cron.js';
import type { AppEnv } from '../src/env.js';
import {
  generationCalls,
  insertUsage,
  scriptGeneration,
  uniq,
  usageRow,
} from './mocks/billing-helpers.js';

const env = { ...(rawEnv as unknown as AppEnv), OPENROUTER_SIMPLE_API_KEY: 'sk-or-cron' } as AppEnv;

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
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('unresolved'),
      expect.objectContaining({ usageId: lost }),
    );
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

    const noKey = { ...env, OPENROUTER_SIMPLE_API_KEY: '' } as AppEnv;
    const old = await insertUsage(env, {
      accountId,
      generationId: uniq('gen'),
      createdAt: ago(30 * HOUR),
    });
    await reconcilePendingUsage(noKey, NOW);
    expect(await usageRow(env, old)).toMatchObject({ status: 'unresolved', charge_micros: 0 });
  });

  it('resolves the OpenRouter key from SIMPLE_PROVIDER or OPENROUTER_SIMPLE_API_KEY', () => {
    expect(simpleApiKey({ ...env, SIMPLE_PROVIDER: '' } as AppEnv)).toBe('sk-or-cron');
    expect(simpleApiKey({ ...env, OPENROUTER_SIMPLE_API_KEY: '' } as AppEnv)).toBeNull();
    const named = {
      ...env,
      SIMPLE_PROVIDER: JSON.stringify({ id: 'openrouter', apiKeySecret: 'OTHER_KEY' }),
      OTHER_KEY: ' sk-other ',
    } as AppEnv;
    expect(simpleApiKey(named)).toBe('sk-other');
    expect(simpleApiKey({ ...env, SIMPLE_PROVIDER: '{bad json' } as AppEnv)).toBe('sk-or-cron');
  });

  it('runs as the cron job at the time the trigger gives it', async () => {
    // Five minutes old at NOW: too young to give up on, whatever today's date.
    const young = await insertUsage(env, { accountId: uniq('acct'), createdAt: ago(5 * MIN) });
    await CRON_JOBS.reconcile(env, NOW);
    expect(await usageRow(env, young)).toMatchObject({ status: 'pending' });
  });
});
