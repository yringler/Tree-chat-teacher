// How each hosted tier asks its model: the `*_EFFORT`, `*_REPLY_TOKENS` and `*_PROVIDER_ORDER` vars of
// Learn's Normal and Max, the open pool and the background calls, and the
// request each one sends upstream. An empty var is the default model's
// evaluated setting while the tier runs that model (a setting tuned for one
// model says nothing about another), else the model's own: no effort, the default caps,
// no pinning.
import { createProviderRegistry } from '@tangent/providers';
import type { GenerateRequest, ProviderConfig } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig, DEFAULT_TIER_REQUESTS, effortVar } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { modelPrice } from '../src/pool/price-table.js';
import { poolModel, resolvePoolParams } from '../src/pool/params.js';
import {
  builtInPowerConfig,
  DEFAULT_BACKGROUND_MODEL,
  DEFAULT_LEARN_MAX_MODEL,
  DEFAULT_LEARN_NORMAL_MODEL,
  poolChatSettings,
  poolProviderConfig,
  simpleChatSettings,
  simpleFastModel,
  simpleProviderConfig,
  suggestedModels,
} from '../src/simple-mode.js';
import { withUsageFactors } from '../src/tiers.js';
import { envWithFailingDb, uniq } from './mocks/billing-helpers.js';
import { shippedEnv } from './mocks/wrangler-vars.js';

const env = rawEnv as unknown as AppEnv;
const TIER_VARS = [
  'LEARN_NORMAL_EFFORT',
  'LEARN_NORMAL_REPLY_TOKENS',
  'LEARN_NORMAL_PROVIDER_ORDER',
  'LEARN_MAX_EFFORT',
  'LEARN_MAX_REPLY_TOKENS',
  'LEARN_MAX_PROVIDER_ORDER',
  'BACKGROUND_EFFORT',
  'POOL_EFFORT',
  'POOL_PROVIDER_ORDER',
] as const;
/** As deployed: the default OpenRouter config, every tier var empty unless overridden. */
const deployed = (overrides: Partial<AppEnv> = {}) =>
  ({
    ...env,
    BUILT_IN_PROVIDER: '',
    LEARN_NORMAL_MODEL: '',
    LEARN_MAX_MODEL: '',
    BACKGROUND_MODEL: '',
    POOL_MODEL: '',
    MODEL_PRICES: '',
    TEST_POOL_ACCOUNT_ID: uniq('pool'),
    ...Object.fromEntries(TIER_VARS.map((k) => [k, ''])),
    ...overrides,
  }) as AppEnv;

/** As wrangler.jsonc deploys it, on a pool of its own. */
const asShipped = () => shippedEnv(env, { TEST_POOL_ACCOUNT_ID: uniq('pool') });

afterEach(() => {
  vi.restoreAllMocks();
});

/** The JSON body `config` sends upstream for `request` (a mocked fetch records it). */
async function sentBody(
  config: ProviderConfig,
  request: Partial<GenerateRequest> & { model: string },
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | null = null;
  const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;
  const registry = createProviderRegistry([config], {
    secrets: { BUILT_IN_API_KEY: 'sk-or-test' },
    fetch,
  });
  for await (const _event of registry.get(config.id)!.stream({
    system: null,
    messages: [{ role: 'user', content: 'hi' }],
    signal: new AbortController().signal,
    ...request,
  }));
  if (body === null) throw new Error('nothing was sent');
  return body;
}

/** V4.1 Flash's pinned providers. */
const PINNED = ['streamlake/fp8', 'deepinfra/fp8'];

describe('tier config vars', () => {
  it('parse empty as unset; the default models fill it in later', () => {
    const c = appConfig(deployed());
    const none = { effort: null, maxOutputTokens: null, providerOrder: [] };
    expect(c.learn.normal).toEqual(none);
    expect(c.learn.max).toEqual(none);
    expect(c.background.effort).toBeNull();
    expect(c.pool).toMatchObject({ effort: null, providerOrder: [] });
    // What an empty var means on each default model.
    expect(DEFAULT_TIER_REQUESTS).toEqual({
      normal: {
        model: 'deepseek/deepseek-v4.1-flash',
        request: { effort: 'high', maxOutputTokens: 16_384, providerOrder: PINNED },
      },
      max: {
        model: 'anthropic/claude-sonnet-5.5',
        request: { effort: null, maxOutputTokens: 16_384, providerOrder: [] },
      },
      pool: {
        model: 'deepseek/deepseek-v4.1-flash',
        request: { effort: 'low', maxOutputTokens: null, providerOrder: PINNED },
      },
    });
  });

  it('wrangler.jsonc ships the same models and settings as the code defaults', async () => {
    const live = asShipped();
    expect(simpleProviderConfig(live).models).toEqual(simpleProviderConfig(deployed()).models);
    expect(simpleChatSettings(live).summaryModel).toBe(DEFAULT_BACKGROUND_MODEL);
    expect(simpleChatSettings(live).summaryEffort).toBe('low');
    const [pool, defaults] = await Promise.all([
      resolvePoolParams(live, null),
      resolvePoolParams(deployed(), null),
    ]);
    expect(pool).toMatchObject({
      model: defaults.model,
      effort: defaults.effort,
      providerOrder: defaults.providerOrder,
      summaryEffort: defaults.summaryEffort,
      maxOutputTokens: 8192,
    });
    expect(pool.model).toBe('deepseek/deepseek-v4.1-flash');
  });

  it("wrangler.jsonc pins V4.1 Flash's price, so the daily sync can't move it", async () => {
    const live = asShipped();
    expect(appConfig(live).priceOverrides).toEqual(['deepseek/deepseek-v4.1-flash']);
    // The entry is the built-in one: $0.15 / $0.60, cache read $0.003, 1M context.
    expect(appConfig(live).prices['deepseek/deepseek-v4.1-flash']).toEqual(
      appConfig(deployed()).prices['deepseek/deepseek-v4.1-flash'],
    );
    expect(await modelPrice(live, 'deepseek/deepseek-v4.1-flash')).toEqual({
      inMicrosPerMTok: 150_000,
      outMicrosPerMTok: 600_000,
      contextTokens: 1_048_576,
      cacheReadMicrosPerMTok: 3_000,
    });
    // The Max note as deployed: about 14×.
    const [info] = await withUsageFactors(live, [
      {
        id: 'openrouter',
        kind: 'openai-compatible',
        label: 'Tangent',
        models: simpleProviderConfig(live).models.map(({ id, label, tier }) => ({
          id,
          label,
          ...(tier ? { tier } : {}),
        })),
        defaultModel: DEFAULT_LEARN_NORMAL_MODEL,
        openModels: false,
        available: true,
        acceptsUserKey: true,
        keySource: 'server',
      },
    ]);
    expect(info!.models[1]).toMatchObject({ tier: 'max', usageFactor: 14 });
  });

  it('parse efforts, reply caps and provider orders', () => {
    const c = appConfig(
      deployed({
        LEARN_NORMAL_EFFORT: ' High ',
        LEARN_NORMAL_REPLY_TOKENS: '12000',
        LEARN_NORMAL_PROVIDER_ORDER: 'deepseek, novita ,',
        LEARN_MAX_EFFORT: 'low',
        BACKGROUND_EFFORT: 'none',
        POOL_EFFORT: 'low',
        POOL_PROVIDER_ORDER: 'deepseek',
      }),
    );
    expect(c.learn.normal).toEqual({
      effort: 'high',
      maxOutputTokens: 12_000,
      providerOrder: ['deepseek', 'novita'],
    });
    expect(c.learn.max).toEqual({ effort: 'low', maxOutputTokens: null, providerOrder: [] });
    expect(c.background.effort).toBe('none');
    expect(c.pool).toMatchObject({ effort: 'low', providerOrder: ['deepseek'] });
  });

  it('refuses max (and anything else) as an effort', () => {
    for (const bad of ['max', 'xhigh', 'medium', 'off', 'minimal'])
      expect(() => effortVar('POOL_EFFORT', bad)).toThrow(
        `Invalid POOL_EFFORT="${bad}": expected none, low or high`,
      );
    expect(effortVar('POOL_EFFORT', undefined)).toBeNull();
    expect(effortVar('POOL_EFFORT', 'NONE')).toBe('none');
  });

  it('refuses a reply cap above the per-call bound (16,384), or a malformed one', () => {
    expect(appConfig(deployed({ LEARN_MAX_REPLY_TOKENS: '16384' })).learn.max.maxOutputTokens).toBe(
      16_384,
    );
    for (const bad of ['40000', '0', '-5', '1.5', 'lots'])
      expect(() => appConfig(deployed({ LEARN_MAX_REPLY_TOKENS: bad }))).toThrow(
        'Invalid LEARN_MAX_REPLY_TOKENS=',
      );
  });
});

describe("Learn's tiers with request settings", () => {
  const tuned = () =>
    deployed({
      LEARN_NORMAL_EFFORT: 'high',
      LEARN_NORMAL_REPLY_TOKENS: '12000',
      LEARN_NORMAL_PROVIDER_ORDER: 'deepseek',
      LEARN_MAX_EFFORT: 'low',
      BACKGROUND_EFFORT: 'none',
    });

  it("put each tier's settings on its model only", () => {
    expect(simpleProviderConfig(tuned()).models).toEqual([
      {
        id: DEFAULT_LEARN_NORMAL_MODEL,
        label: 'Normal',
        tier: 'normal',
        effort: 'high',
        maxOutputTokens: 12_000,
        providerOrder: ['deepseek'],
      },
      // An empty reply cap is still the default model's.
      {
        id: DEFAULT_LEARN_MAX_MODEL,
        label: 'Max',
        tier: 'max',
        effort: 'low',
        maxOutputTokens: 16_384,
      },
    ]);
    // Power's suggestions and Tangent credit don't take them (the user picks there).
    expect(suggestedModels(tuned()).every((m) => !('effort' in m))).toBe(true);
    expect(builtInPowerConfig(tuned()).models.every((m) => !('effort' in m))).toBe(true);
  });

  it('cap the reply at the tier cap and send the effort and pinning upstream', async () => {
    const config = simpleProviderConfig(tuned());
    const registry = createProviderRegistry([config], { secrets: {} });
    expect(registry.get(config.id)!.capabilities(DEFAULT_LEARN_NORMAL_MODEL).maxOutputTokens).toBe(
      12_000,
    );
    const normal = await sentBody(config, { model: DEFAULT_LEARN_NORMAL_MODEL });
    expect(normal).toMatchObject({
      reasoning: { effort: 'high' },
      provider: { order: ['deepseek'], allow_fallbacks: true },
    });
    const max = await sentBody(config, { model: DEFAULT_LEARN_MAX_MODEL });
    expect(max['reasoning']).toEqual({ effort: 'low' });
    expect(max).not.toHaveProperty('provider');
  });

  it('are server-side: the providers list never shows them', () => {
    const [info] = createProviderRegistry([simpleProviderConfig(tuned())], {
      secrets: {},
    }).list();
    for (const m of info!.models) {
      expect(m).not.toHaveProperty('effort');
      expect(m).not.toHaveProperty('providerOrder');
    }
    expect(info!.models[0]!.maxOutputTokens).toBe(12_000);
  });

  it('give summaries and titles the background effort', () => {
    expect(simpleChatSettings(tuned()).summaryEffort).toBe('none');
    expect(simpleChatSettings(deployed()).summaryEffort).toBe('low');
  });

  it('ask the default models as evaluated by default', async () => {
    const config = simpleProviderConfig(deployed());
    expect(config.models).toEqual([
      {
        id: DEFAULT_LEARN_NORMAL_MODEL,
        label: 'Normal',
        tier: 'normal',
        effort: 'high',
        maxOutputTokens: 16_384,
        providerOrder: PINNED,
      },
      { id: DEFAULT_LEARN_MAX_MODEL, label: 'Max', tier: 'max', maxOutputTokens: 16_384 },
    ]);
    const normal = await sentBody(config, { model: DEFAULT_LEARN_NORMAL_MODEL });
    expect(normal).toMatchObject({
      reasoning: { effort: 'high' },
      provider: { order: PINNED, allow_fallbacks: true },
    });
    const max = await sentBody(config, { model: DEFAULT_LEARN_MAX_MODEL });
    expect(max).not.toHaveProperty('reasoning');
    expect(max).not.toHaveProperty('provider');
  });

  it("ask another model with its own defaults: the default model's settings stay with it", async () => {
    const config = simpleProviderConfig(
      deployed({ LEARN_NORMAL_MODEL: 'minimax/minimax-m3', LEARN_MAX_MODEL: 'x/other-max' }),
    );
    expect(config.models).toEqual([
      { id: 'minimax/minimax-m3', label: 'Normal', tier: 'normal' },
      { id: 'x/other-max', label: 'Max', tier: 'max' },
    ]);
    const body = await sentBody(config, { model: 'minimax/minimax-m3' });
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('provider');
  });
});

describe('the open pool with request settings', () => {
  it("asks the pool model with the pool's effort and pinning, merged with its max_price", async () => {
    const e = deployed({
      POOL_EFFORT: 'low',
      POOL_PROVIDER_ORDER: 'deepseek',
      BACKGROUND_EFFORT: 'none',
      // A tier on the same model keeps its own settings off the pool.
      LEARN_NORMAL_MODEL: DEFAULT_BACKGROUND_MODEL,
      LEARN_NORMAL_EFFORT: 'high',
    });
    const pool = await resolvePoolParams(e, null);
    const config = poolProviderConfig(e, pool);
    expect(config.models).toEqual([
      {
        id: DEFAULT_BACKGROUND_MODEL,
        label: 'Normal',
        effort: 'low',
        providerOrder: ['deepseek'],
      },
    ]);
    const body = await sentBody(config, { model: pool.model });
    expect(body['reasoning']).toEqual({ effort: 'low' });
    expect(body['provider']).toEqual({
      order: ['deepseek'],
      allow_fallbacks: true,
      max_price: {
        prompt: pool.price!.inMicrosPerMTok / 1_000_000,
        completion: pool.price!.outMicrosPerMTok / 1_000_000,
      },
    });
    // A call that asks for no thinking (a summary at `none`) turns it off whatever the pool's effort.
    const unthinking = await sentBody(config, { model: pool.model, reasoning: 'none' });
    expect(unthinking['reasoning']).toEqual({ enabled: false });
    expect(poolChatSettings(pool).summaryEffort).toBe('none');
  });

  it('asks the default pool model at low effort on its pinned providers, within max_price', async () => {
    const e = deployed();
    const pool = await resolvePoolParams(e, null);
    expect(pool.model).toBe('deepseek/deepseek-v4.1-flash');
    const body = await sentBody(poolProviderConfig(e, pool), { model: pool.model });
    expect(body['reasoning']).toEqual({ effort: 'low' });
    // Both pinned providers charge at most $0.15 / $0.60 per MTok, so max_price admits them.
    expect(body['provider']).toEqual({
      order: PINNED,
      allow_fallbacks: true,
      max_price: { prompt: 0.15, completion: 0.6 },
    });
  });

  it('keeps only max_price on another model by default', async () => {
    const e = deployed({ POOL_MODEL: 'minimax/minimax-m3' });
    const pool = await resolvePoolParams(e, null);
    const body = await sentBody(poolProviderConfig(e, pool), { model: pool.model });
    expect(body).not.toHaveProperty('reasoning');
    expect(Object.keys(body['provider'] as object)).toEqual(['max_price']);
  });
});

describe('MiniMax M3, a config-only fallback', () => {
  it('is priced (so the pool may run it) but no default', async () => {
    const e = deployed({ POOL_MODEL: 'minimax/minimax-m3' });
    const pool = await resolvePoolParams(e, null);
    expect(pool.price).not.toBeNull();
    expect(pool.price).toMatchObject({ inMicrosPerMTok: 300_000, outMicrosPerMTok: 1_200_000 });
    expect(simpleProviderConfig(deployed()).models.some((m) => m.id.startsWith('minimax/'))).toBe(
      false,
    );
    const tier = simpleProviderConfig(deployed({ LEARN_NORMAL_MODEL: 'minimax/minimax-m3' }));
    expect(tier.models[0]).toMatchObject({ id: 'minimax/minimax-m3', tier: 'normal' });
  });
});

describe('prices as shipped', () => {
  it('prices every model a user can pick or a hosted call runs on, before any sync', async () => {
    // wrangler.jsonc's vars, and no synced price readable: what a fresh deploy holds credit at.
    const shipped = shippedEnv(env, { DB: envWithFailingDb(env, /model_prices/).DB });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const models = new Set([
      ...simpleProviderConfig(shipped).models.map((m) => m.id),
      ...suggestedModels(shipped).map((m) => m.id),
      simpleFastModel(shipped),
      poolModel(shipped),
    ]);
    expect(models.size).toBeGreaterThan(1);
    for (const model of models) {
      expect(await modelPrice(shipped, model), model).not.toBeNull();
    }
  });
});
