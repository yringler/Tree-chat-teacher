import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_PRICES } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import {
  creditPrice,
  modelPrice,
  withCacheWritePrice,
  OPENROUTER_MODELS_URL,
  parseListPrices,
  storedPrice,
  syncModelPrices,
  usdPerTokenToMicrosPerMTok,
} from '../src/pool/model-prices.js';
import { resolvePoolParams } from '../src/pool/params.js';
import { envWithFailingDb } from './mocks/billing-helpers.js';
import { ON_DEMAND_MODEL } from './mocks/openrouter.js';

const FLASH = 'deepseek/deepseek-v4-flash';
const PRO = 'deepseek/deepseek-v4-pro';
/** Normal's and the pool's default model, priced like the others (and so tracked). */
const V41 = 'deepseek/deepseek-v4.1-flash';
/** Learn's Max tier: priced (and so tracked) for the Max usage note, not for the pool. */
const SONNET = 'anthropic/claude-sonnet-5.5';
/** The fallback candidate: priced (and so tracked) though no default. */
const MINIMAX = 'minimax/minimax-m3';

/**
 * The price setup without `MODEL_PRICES`, so the built-in placeholders
 * (V4.1 Flash, FLASH, PRO and the rest) are what the sync refreshes; the pool
 * runs on FLASH here.
 */
const env = { ...rawEnv, MODEL_PRICES: '', POOL_MODEL: FLASH } as unknown as AppEnv;

interface Listed {
  id: string;
  prompt: string;
  completion: string;
  context?: number;
  cacheRead?: string;
  cacheWrite?: string;
}

/** A `fetch` serving `GET /api/v1/models` with `models`, recording the URLs asked for. */
function listing(models: Listed[]) {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json({
      data: models.map((m) => ({
        id: m.id,
        pricing: {
          prompt: m.prompt,
          completion: m.completion,
          ...(m.cacheRead !== undefined ? { input_cache_read: m.cacheRead } : {}),
          ...(m.cacheWrite !== undefined ? { input_cache_write: m.cacheWrite } : {}),
        },
        context_length: m.context ?? null,
      })),
    });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

async function historyOf(model: string) {
  const { results } = await env.DB.prepare(
    'SELECT in_micros_per_mtok AS inp, out_micros_per_mtok AS out, recorded_at AS at FROM model_price_history WHERE model = ?1 ORDER BY recorded_at',
  )
    .bind(model)
    .all<{ inp: number; out: number; at: string }>();
  return results;
}

const T0 = new Date('2026-01-01T03:23:00Z');
const T1 = new Date('2026-01-02T03:23:00Z');

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM model_prices'),
    env.DB.prepare('DELETE FROM model_price_history'),
  ]);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('usdPerTokenToMicrosPerMTok', () => {
  it('converts USD per token to µ$ per million tokens exactly', () => {
    expect(usdPerTokenToMicrosPerMTok('0.000002')).toBe(2_000_000);
    expect(usdPerTokenToMicrosPerMTok('0.00000015')).toBe(150_000);
    // Floats get this one wrong: 0.0000002 × 1e12 = 199999.99999999997.
    expect(usdPerTokenToMicrosPerMTok('0.0000002')).toBe(200_000);
    expect(usdPerTokenToMicrosPerMTok('0.000000000001')).toBe(1);
    expect(usdPerTokenToMicrosPerMTok('15')).toBe(15_000_000_000_000);
    expect(usdPerTokenToMicrosPerMTok(' 0 ')).toBe(0);
  });

  it('rounds a fraction of a µ$/MTok up', () => {
    expect(usdPerTokenToMicrosPerMTok('0.0000000000001')).toBe(1);
    expect(usdPerTokenToMicrosPerMTok('0.0000000000010')).toBe(1);
    expect(usdPerTokenToMicrosPerMTok('0.0000010000001')).toBe(1_000_001);
  });

  it('rejects the variable-price "-1", exponents, numbers and unsafe values', () => {
    for (const bad of ['-1', '1e-6', '', '.5', 'abc', '0.000002 x', '99999999'])
      expect(usdPerTokenToMicrosPerMTok(bad)).toBeNull();
    expect(usdPerTokenToMicrosPerMTok(0.000002)).toBeNull();
    expect(usdPerTokenToMicrosPerMTok(undefined)).toBeNull();
  });
});

describe('parseListPrices', () => {
  it('reads each listed price; an unusable one is null', () => {
    const prices = parseListPrices({
      data: [
        {
          id: 'a/one',
          pricing: { prompt: '0.000001', completion: '0.000004' },
          context_length: 64_000,
        },
        { id: 'a/two', pricing: { prompt: '0', completion: '0' }, context_length: 0 },
        { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
        { id: 'a/no-pricing' },
        { pricing: { prompt: '1', completion: '1' } },
        'junk',
      ],
    });
    const noCache = { cacheReadMicrosPerMTok: null, cacheWriteMicrosPerMTok: null };
    expect(Object.fromEntries(prices)).toEqual({
      'a/one': {
        inMicrosPerMTok: 1_000_000,
        outMicrosPerMTok: 4_000_000,
        contextTokens: 64_000,
        ...noCache,
      },
      'a/two': { inMicrosPerMTok: 0, outMicrosPerMTok: 0, contextTokens: null, ...noCache },
      'openrouter/auto': null,
      'a/no-pricing': null,
    });
  });

  it('reads the cache prices when listed; an unusable one is null, not the whole price', () => {
    const prices = parseListPrices({
      data: [
        {
          id: 'anthropic/claude-sonnet-5.5',
          pricing: {
            prompt: '0.000002',
            completion: '0.00001',
            input_cache_read: '0.0000001',
            input_cache_write: '0.0000025',
            input_cache_write_1h: '0.000004',
          },
        },
        {
          id: 'deepseek/deepseek-v4-pro',
          pricing: {
            prompt: '0.00000095526',
            completion: '0.00000191052',
            input_cache_read: '0.000000079605',
          },
        },
        {
          id: 'a/odd',
          pricing: {
            prompt: '0.000001',
            completion: '0.000001',
            input_cache_read: '-1',
            input_cache_write: 5,
          },
        },
      ],
    });
    expect(prices.get('anthropic/claude-sonnet-5.5')).toMatchObject({
      inMicrosPerMTok: 2_000_000,
      cacheReadMicrosPerMTok: 100_000,
      cacheWriteMicrosPerMTok: 2_500_000,
    });
    expect(prices.get('deepseek/deepseek-v4-pro')).toMatchObject({
      cacheReadMicrosPerMTok: 79_605,
      cacheWriteMicrosPerMTok: null,
    });
    expect(prices.get('a/odd')).toMatchObject({
      inMicrosPerMTok: 1_000_000,
      cacheReadMicrosPerMTok: null,
      cacheWriteMicrosPerMTok: null,
    });
  });

  it('throws on a body without a data array', () => {
    expect(() => parseListPrices({ error: 'nope' })).toThrow(/no data array/);
    expect(() => parseListPrices(null)).toThrow(/no data array/);
  });
});

describe('syncModelPrices', () => {
  it('stores the tracked models’ list prices and records them in the history', async () => {
    const { fetchImpl, urls } = listing([
      { id: FLASH, prompt: '0.00000027', completion: '0.0000011', context: 163_840 },
      { id: PRO, prompt: '0.0000006', completion: '0.0000024', context: 64_000 },
      { id: 'someone/else', prompt: '0.001', completion: '0.001' },
    ]);
    const result = await syncModelPrices(env, T0, fetchImpl);
    expect(urls).toEqual([OPENROUTER_MODELS_URL]);
    expect(result).toEqual({
      changed: [FLASH, PRO],
      unchanged: [],
      missing: [V41, SONNET, MINIMAX],
      anomalies: [],
    });
    expect(await storedPrice(env.DB, FLASH)).toEqual({
      inMicrosPerMTok: 270_000,
      outMicrosPerMTok: 1_100_000,
      contextTokens: 163_840,
      cacheReadMicrosPerMTok: null,
      cacheWriteMicrosPerMTok: null,
    });
    expect(await historyOf(PRO)).toEqual([{ inp: 600_000, out: 2_400_000, at: T0.toISOString() }]);
  });

  it('prices a credit model the store does not know yet by syncing once, on demand', async () => {
    // The default built-in provider is OpenRouter; its model list is the mock's.
    const openRouter = { ...env, SIMPLE_PROVIDER: '' } as AppEnv;
    expect(await storedPrice(env.DB, ON_DEMAND_MODEL)).toBeNull();
    expect(await creditPrice(openRouter, ON_DEMAND_MODEL)).toEqual({
      inMicrosPerMTok: 1_000_000,
      outMicrosPerMTok: 2_000_000,
      contextTokens: 32_000,
    });
    // Not on another endpoint, which the sync can't list.
    expect(await creditPrice(env, 'vendor/elsewhere')).toBeNull();
  });

  it("stores every other listed model's price for credit, without history, and holds back a collapse", async () => {
    const other = 'someone/else';
    await syncModelPrices(
      env,
      T0,
      listing([{ id: other, prompt: '0.001', completion: '0.002', context: 8_000 }]).fetchImpl,
    );
    expect(await storedPrice(env.DB, other)).toEqual({
      inMicrosPerMTok: 1_000_000_000,
      outMicrosPerMTok: 2_000_000_000,
      contextTokens: 8_000,
      cacheReadMicrosPerMTok: null,
      cacheWriteMicrosPerMTok: null,
    });
    expect(await historyOf(other)).toEqual([]);
    // The pool still prices only configured models; credit reads the stored list price.
    expect(await modelPrice(env, other)).toBeNull();
    expect(await creditPrice(env, other)).toEqual({
      inMicrosPerMTok: 1_000_000_000,
      outMicrosPerMTok: 2_000_000_000,
      contextTokens: 8_000,
    });
    expect(await creditPrice(env, 'never/listed')).toBeNull();
    // A drop to under a tenth is held back, as for a tracked model.
    await syncModelPrices(
      env,
      T1,
      listing([{ id: other, prompt: '0.00001', completion: '0.002' }]).fetchImpl,
    );
    expect((await storedPrice(env.DB, other))?.inMicrosPerMTok).toBe(1_000_000_000);
    // Logged once for all the models held back, not a line each.
    const anomalies = error.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('"event":"price_sync_anomaly"'),
    );
    expect(anomalies).toEqual([[JSON.stringify({ event: 'price_sync_anomaly', models: [other] })]]);
  });

  it('confirms an unchanged price without a new history row; a change adds one and is logged', async () => {
    const day0 = listing([
      { id: FLASH, prompt: '0.00000027', completion: '0.0000011' },
      { id: PRO, prompt: '0.0000006', completion: '0.0000024' },
    ]);
    await syncModelPrices(env, T0, day0.fetchImpl);
    const day1 = listing([
      { id: FLASH, prompt: '0.00000027', completion: '0.0000011' },
      { id: PRO, prompt: '0.0000009', completion: '0.0000024' },
    ]);
    const result = await syncModelPrices(env, T1, day1.fetchImpl);
    expect(result).toMatchObject({ changed: [PRO], unchanged: [FLASH] });
    expect(await historyOf(FLASH)).toHaveLength(1);
    expect((await historyOf(PRO)).map((h) => h.inp)).toEqual([600_000, 900_000]);
    const fetchedAt = await env.DB.prepare('SELECT fetched_at FROM model_prices WHERE model = ?1')
      .bind(FLASH)
      .first<string>('fetched_at');
    expect(fetchedAt).toBe(T1.toISOString());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"price_changed"'));
  });

  it('applies any increase, but holds back a drop to under a tenth and logs it', async () => {
    await syncModelPrices(
      env,
      T0,
      listing([
        { id: FLASH, prompt: '0.000001', completion: '0.000001' },
        { id: PRO, prompt: '0.000001', completion: '0.000001' },
      ]).fetchImpl,
    );
    const result = await syncModelPrices(
      env,
      T1,
      listing([
        { id: FLASH, prompt: '0.0001', completion: '0.000001' }, // ×100: applied
        { id: PRO, prompt: '0.000001', completion: '0.00000009' }, // out ÷11: held back
      ]).fetchImpl,
    );
    expect(result).toMatchObject({ changed: [FLASH], anomalies: [PRO] });
    expect((await storedPrice(env.DB, FLASH))?.inMicrosPerMTok).toBe(100_000_000);
    expect((await storedPrice(env.DB, PRO))?.outMicrosPerMTok).toBe(1_000_000);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"event":"price_sync_anomaly"'));
  });

  it('keeps the stored price of a model the list dropped or prices unusably', async () => {
    await syncModelPrices(
      env,
      T0,
      listing([
        { id: FLASH, prompt: '0.000001', completion: '0.000002' },
        { id: PRO, prompt: '0.000001', completion: '0.000002' },
      ]).fetchImpl,
    );
    const result = await syncModelPrices(
      env,
      T1,
      listing([{ id: PRO, prompt: '-1', completion: '-1' }]).fetchImpl,
    );
    expect(result).toEqual({
      changed: [],
      unchanged: [],
      missing: [V41, FLASH, PRO, SONNET, MINIMAX],
      anomalies: [],
    });
    expect((await storedPrice(env.DB, FLASH))?.outMicrosPerMTok).toBe(2_000_000);
    expect((await storedPrice(env.DB, PRO))?.outMicrosPerMTok).toBe(2_000_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"price_sync_missing"'));
  });

  it('stores the listed cache prices; a cache price change is a new price, a collapse is held back', async () => {
    const day0 = listing([
      { id: FLASH, prompt: '0.00000027', completion: '0.0000011', cacheRead: '0.00000003' },
      { id: PRO, prompt: '0.0000006', completion: '0.0000024', cacheRead: '0.00000006' },
    ]);
    await syncModelPrices(env, T0, day0.fetchImpl);
    expect(await storedPrice(env.DB, FLASH)).toMatchObject({
      cacheReadMicrosPerMTok: 30_000,
      cacheWriteMicrosPerMTok: null,
    });
    const day1 = listing([
      // A cache read price change alone is a change (history row).
      { id: FLASH, prompt: '0.00000027', completion: '0.0000011', cacheRead: '0.00000004' },
      // A cache read price at under a tenth is held back like an input price.
      { id: PRO, prompt: '0.0000006', completion: '0.0000024', cacheRead: '0.000000005' },
    ]);
    const result = await syncModelPrices(env, T1, day1.fetchImpl);
    expect(result).toMatchObject({ changed: [FLASH], anomalies: [PRO] });
    expect((await storedPrice(env.DB, FLASH))?.cacheReadMicrosPerMTok).toBe(40_000);
    expect((await storedPrice(env.DB, PRO))?.cacheReadMicrosPerMTok).toBe(60_000);
    const { results } = await env.DB.prepare(
      'SELECT cache_read_micros_per_mtok AS r FROM model_price_history WHERE model = ?1 ORDER BY recorded_at',
    )
      .bind(FLASH)
      .all<{ r: number | null }>();
    expect(results.map((h) => h.r)).toEqual([30_000, 40_000]);
  });

  it('throws and stores nothing when the list cannot be fetched', async () => {
    const down = (async () => new Response('oops', { status: 503 })) as typeof fetch;
    await expect(syncModelPrices(env, T0, down)).rejects.toThrow(/HTTP 503/);
    const offline = (async () => {
      throw new TypeError('network down');
    }) as typeof fetch;
    await expect(syncModelPrices(env, T0, offline)).rejects.toThrow(/network down/);
    const garbled = (async () => Response.json({ models: [] })) as typeof fetch;
    await expect(syncModelPrices(env, T0, garbled)).rejects.toThrow(/no data array/);
    expect(await storedPrice(env.DB, FLASH)).toBeNull();
  });

  it('tracks overridden models too, and warns when an override is below the list price', async () => {
    const overridden = {
      ...env,
      MODEL_PRICES: JSON.stringify({ [FLASH]: { in: 100_000, out: 400_000, context: 131_072 } }),
    } as AppEnv;
    await syncModelPrices(
      overridden,
      T0,
      listing([
        { id: FLASH, prompt: '0.0000003', completion: '0.0000003' },
        { id: PRO, prompt: '0.0000003', completion: '0.0000003' },
      ]).fetchImpl,
    );
    expect((await storedPrice(env.DB, FLASH))?.inMicrosPerMTok).toBe(300_000);
    const below = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('price_override_below_list'),
    );
    expect(below).toHaveLength(1);
    expect(String(below[0]?.[0])).toContain(FLASH);
  });
});

describe('modelPrice', () => {
  const sync = (models: Listed[]) => syncModelPrices(env, T0, listing(models).fetchImpl);

  it('is the built-in placeholder until a sync stores a price', async () => {
    expect(await modelPrice(env, FLASH)).toEqual(DEFAULT_MODEL_PRICES[FLASH]);
  });

  it('is the synced price, within the lower of the configured and listed context windows', async () => {
    await sync([
      { id: FLASH, prompt: '0.00000027', completion: '0.0000011', context: 1_000_000 },
      { id: PRO, prompt: '0.0000006', completion: '0.0000024', context: 64_000 },
    ]);
    expect(await modelPrice(env, FLASH)).toEqual({
      inMicrosPerMTok: 270_000,
      outMicrosPerMTok: 1_100_000,
      contextTokens: 131_072,
    });
    expect((await modelPrice(env, PRO))?.contextTokens).toBe(64_000);
  });

  it('keeps the configured window when the list reports none', async () => {
    await sync([{ id: FLASH, prompt: '0.00000027', completion: '0.0000011' }]);
    expect((await modelPrice(env, FLASH))?.contextTokens).toBe(131_072);
  });

  it('is an explicit MODEL_PRICES entry whatever was synced, keeping its fee', async () => {
    await sync([{ id: FLASH, prompt: '0.00000027', completion: '0.0000011' }]);
    const overridden = {
      ...env,
      MODEL_PRICES: JSON.stringify({ [FLASH]: { in: 5, out: 6, context: 1000, feeBps: 0 } }),
    } as AppEnv;
    expect(await modelPrice(overridden, FLASH)).toEqual({
      inMicrosPerMTok: 5,
      outMicrosPerMTok: 6,
      contextTokens: 1000,
      feeBps: 0,
    });
  });

  it("keeps V4.1 Flash at its MODEL_PRICES entry: OpenRouter's model-level price is no route's", async () => {
    // OpenRouter's model-level list price ($0.0356 in, $1.00 out): the cheapest input of any
    // endpoint with a dearer one's output. As the pool's max_price it admits only fp4 endpoints.
    const modelLevel = { id: V41, prompt: '0.0000000356', completion: '0.000001' };
    await sync([modelLevel]);
    // A drop of less than 10×, so without an entry the sync replaces the placeholder ...
    expect(await modelPrice(env, V41)).toMatchObject({
      inMicrosPerMTok: 35_600,
      outMicrosPerMTok: 1_000_000,
    });
    // ... but an entry, as wrangler.jsonc ships, wins over it: the pinned providers' price.
    const pinned = {
      ...env,
      MODEL_PRICES: JSON.stringify({
        [V41]: { in: 150_000, out: 600_000, context: 1_048_576, cacheRead: 3_000 },
      }),
    } as AppEnv;
    expect(await modelPrice(pinned, V41)).toEqual(DEFAULT_MODEL_PRICES[V41]);
    // Its daily sync still records the list price, and warns that the entry's output is below it.
    warn.mockClear();
    await syncModelPrices(pinned, T1, listing([modelLevel]).fetchImpl);
    expect((await storedPrice(env.DB, V41))?.outMicrosPerMTok).toBe(1_000_000);
    expect(
      warn.mock.calls.some(
        (c: unknown[]) =>
          String(c[0]).includes('price_override_below_list') && String(c[0]).includes(V41),
      ),
    ).toBe(true);
    expect(await modelPrice(pinned, V41)).toEqual(DEFAULT_MODEL_PRICES[V41]);
  });

  it('gives explicit-cache (Anthropic) models the cache-write premium unless configured', async () => {
    const SONNET = 'anthropic/claude-sonnet-5.5';
    const priced = {
      ...env,
      MODEL_PRICES: JSON.stringify({
        [SONNET]: { in: 2_000_001, out: 10_000_000, context: 200_000 },
        'anthropic/claude-haiku-5.5': {
          in: 100_000,
          out: 500_000,
          context: 200_000,
          cacheWrite: 120_000,
          cacheRead: 10_000,
        },
      }),
    } as AppEnv;
    expect(await modelPrice(priced, SONNET)).toEqual({
      inMicrosPerMTok: 2_000_001,
      outMicrosPerMTok: 10_000_000,
      contextTokens: 200_000,
      cacheWriteMicrosPerMTok: 2_500_002, // ⌈2_000_001 × 1.25⌉
    });
    expect(await modelPrice(priced, 'anthropic/claude-haiku-5.5')).toMatchObject({
      cacheReadMicrosPerMTok: 10_000,
      cacheWriteMicrosPerMTok: 120_000,
    });
    // Automatic-cache models write at the input price: no premium.
    expect(await modelPrice(env, FLASH)).not.toHaveProperty('cacheWriteMicrosPerMTok');
    expect(withCacheWritePrice('google/gemini-3-pro', DEFAULT_MODEL_PRICES[FLASH]!)).toEqual(
      DEFAULT_MODEL_PRICES[FLASH],
    );
  });

  it('is the synced cache prices over the fallbacks; an override keeps its own', async () => {
    await sync([
      { id: FLASH, prompt: '0.00000027', completion: '0.0000011', cacheRead: '0.00000003' },
      {
        id: PRO,
        prompt: '0.0000006',
        completion: '0.0000024',
        cacheRead: '0.00000006',
        cacheWrite: '0.0000007',
      },
    ]);
    // Listed read price, no write price listed (DeepSeek): the write stays the input price.
    expect(await modelPrice(env, FLASH)).toEqual({
      inMicrosPerMTok: 270_000,
      outMicrosPerMTok: 1_100_000,
      contextTokens: 131_072,
      cacheReadMicrosPerMTok: 30_000,
    });
    expect(await modelPrice(env, PRO)).toMatchObject({
      cacheReadMicrosPerMTok: 60_000,
      cacheWriteMicrosPerMTok: 700_000,
    });

    // An explicit MODEL_PRICES entry wins wholesale, cache prices included (as for input/output).
    const SONNET = 'anthropic/claude-sonnet-5.5';
    const overridden = {
      ...env,
      MODEL_PRICES: JSON.stringify({
        [SONNET]: { in: 3_000_000, out: 20_000_000, context: 200_000, cacheRead: 1 },
      }),
    } as AppEnv;
    await syncModelPrices(
      overridden,
      T0,
      listing([
        {
          id: SONNET,
          prompt: '0.000002',
          completion: '0.00001',
          cacheRead: '0.0000001',
          cacheWrite: '0.0000025',
        },
      ]).fetchImpl,
    );
    expect((await storedPrice(env.DB, SONNET))?.cacheWriteMicrosPerMTok).toBe(2_500_000);
    expect(await modelPrice(overridden, SONNET)).toEqual({
      inMicrosPerMTok: 3_000_000,
      outMicrosPerMTok: 20_000_000,
      contextTokens: 200_000,
      cacheReadMicrosPerMTok: 1,
      cacheWriteMicrosPerMTok: 3_750_000, // the override's own 1.25× fallback, not the synced price
    });
    // …and an override below a listed cache price (only) is flagged.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"price_override_below_list"'),
    );
  });

  it('is null for a model with no configured entry, even when synced', async () => {
    await env.DB.prepare(
      "INSERT INTO model_prices (model, in_micros_per_mtok, out_micros_per_mtok, context_tokens, fetched_at) VALUES ('x/unknown', 1, 1, NULL, '2026-01-01T00:00:00.000Z')",
    ).run();
    expect(await modelPrice(env, 'x/unknown')).toBeNull();
  });

  it('falls back to the configured entry when D1 cannot be read', async () => {
    await sync([{ id: FLASH, prompt: '0.00000027', completion: '0.0000011' }]);
    const broken = envWithFailingDb(env, /model_prices/);
    expect(await modelPrice(broken, FLASH)).toEqual(DEFAULT_MODEL_PRICES[FLASH]);
    expect(error).toHaveBeenCalled();
  });

  it('prices the pool’s holds (resolvePoolParams) at the synced price', async () => {
    await sync([{ id: FLASH, prompt: '0.00000027', completion: '0.0000011' }]);
    expect((await resolvePoolParams(env, null)).price).toEqual({
      inMicrosPerMTok: 270_000,
      outMicrosPerMTok: 1_100_000,
      contextTokens: 131_072,
      feeBps: 550,
    });
  });
});
