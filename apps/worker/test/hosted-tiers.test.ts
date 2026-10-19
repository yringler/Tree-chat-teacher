// How each hosted tier asks its model: the `*_EFFORT`, `*_REPLY_TOKENS` and `*_PROVIDER_ORDER` vars of
// Learn's Normal (which the open pool runs too, within its own caps) and the background calls, and
// the request each one sends upstream. An empty var is the default model's
// evaluated setting while the tier runs that model (a setting tuned for one
// model says nothing about another), else the model's own: no effort, the default caps,
// no pinning.
import { createProviderRegistry } from '@tangent/providers';
import {
  BUILT_IN_MAX_OUTPUT_TOKENS,
  type GenerateRequest,
  type ProviderConfig,
} from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig, DEFAULT_TIER_REQUESTS, effortVar } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { modelPrice } from '../src/pool/price-table.js';
import { poolModel, replyCeilingMicros, resolvePoolParams } from '../src/pool/params.js';
import {
  builtInPowerConfig,
  DEFAULT_BACKGROUND_MODEL,
  DEFAULT_LEARN_NORMAL_MODEL,
  DEFAULT_POWER_MAX_MODEL,
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
  'BACKGROUND_EFFORT',
] as const;
/** As deployed: the default OpenRouter config, every tier var empty unless overridden. */
const deployed = (overrides: Partial<AppEnv> = {}) =>
  ({
    ...env,
    BUILT_IN_PROVIDER: '',
    LEARN_NORMAL_MODEL: '',
    POWER_MAX_MODEL: '',
    BACKGROUND_MODEL: '',
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

/** Where Normal's Haiku is pinned: Anthropic's own endpoint, which keeps one prompt cache. */
const HAIKU_PINNED = ['anthropic'];

describe('tier config vars', () => {
  it('parse empty as unset; the default models fill it in later', () => {
    const c = appConfig(deployed());
    const none = { effort: null, maxOutputTokens: null, providerOrder: [] };
    expect(c.learn.normal).toEqual(none);
    expect(c.background.effort).toBeNull();
    // What an empty var means on the default model.
    expect(DEFAULT_TIER_REQUESTS).toEqual({
      normal: {
        model: 'anthropic/claude-haiku-5.5',
        request: { effort: 'high', maxOutputTokens: 16_384, providerOrder: HAIKU_PINNED },
      },
    });
  });

  it('wrangler.jsonc ships the same models and settings as the code defaults', async () => {
    const live = asShipped();
    expect(simpleProviderConfig(live).models).toEqual(simpleProviderConfig(deployed()).models);
    expect(simpleChatSettings(live, 'openrouter').summaryModel).toBe(DEFAULT_BACKGROUND_MODEL);
    expect(simpleChatSettings(live, 'openrouter').summaryEffort).toBe('low');
    const [pool, defaults] = await Promise.all([
      resolvePoolParams(live, null),
      resolvePoolParams(deployed(), null),
    ]);
    expect(pool).toMatchObject({
      model: defaults.model,
      summaryEffort: defaults.summaryEffort,
      maxOutputTokens: BUILT_IN_MAX_OUTPUT_TOKENS,
    });
    expect(pool.model).toBe(DEFAULT_LEARN_NORMAL_MODEL);
  });

  it('wrangler.jsonc pins no price, so the daily sync keeps every price current', async () => {
    const live = asShipped();
    expect(appConfig(live).priceOverrides).toEqual([]);
    // Power's Max note as deployed: about 20× (Haiku 5.5 against Sonnet 5.5).
    const [info] = await withUsageFactors(live, [
      {
        id: 'openrouter',
        kind: 'openai-compatible',
        label: 'Tangent credit',
        models: builtInPowerConfig(live).models,
        defaultModel: DEFAULT_LEARN_NORMAL_MODEL,
        openModels: false,
        available: true,
        acceptsUserKey: true,
        keySource: 'server',
      },
    ]);
    expect(info!.models[1]).toMatchObject({ tier: 'max', usageFactor: 20 });
  });

  it('parse efforts, reply caps and provider orders', () => {
    const c = appConfig(
      deployed({
        LEARN_NORMAL_EFFORT: ' High ',
        LEARN_NORMAL_REPLY_TOKENS: '12000',
        LEARN_NORMAL_PROVIDER_ORDER: 'deepseek, novita ,',
        BACKGROUND_EFFORT: 'none',
      }),
    );
    expect(c.learn.normal).toEqual({
      effort: 'high',
      maxOutputTokens: 12_000,
      providerOrder: ['deepseek', 'novita'],
    });
    expect(c.background.effort).toBe('none');
  });

  it('refuses max (and anything else) as an effort', () => {
    for (const bad of ['max', 'xhigh', 'medium', 'off', 'minimal'])
      expect(() => effortVar('LEARN_NORMAL_EFFORT', bad)).toThrow(
        `Invalid LEARN_NORMAL_EFFORT="${bad}": expected none, low or high`,
      );
    expect(effortVar('LEARN_NORMAL_EFFORT', undefined)).toBeNull();
    expect(effortVar('LEARN_NORMAL_EFFORT', 'NONE')).toBe('none');
  });

  it('refuses a reply cap above the per-call bound (16,384), or a malformed one', () => {
    expect(
      appConfig(deployed({ LEARN_NORMAL_REPLY_TOKENS: '16384' })).learn.normal.maxOutputTokens,
    ).toBe(16_384);
    for (const bad of ['40000', '0', '-5', '1.5', 'lots'])
      expect(() => appConfig(deployed({ LEARN_NORMAL_REPLY_TOKENS: bad }))).toThrow(
        'Invalid LEARN_NORMAL_REPLY_TOKENS=',
      );
  });
});

describe("Learn's Normal with request settings", () => {
  const tuned = () =>
    deployed({
      LEARN_NORMAL_EFFORT: 'high',
      LEARN_NORMAL_REPLY_TOKENS: '12000',
      LEARN_NORMAL_PROVIDER_ORDER: 'deepseek',
      BACKGROUND_EFFORT: 'none',
    });

  it("put Normal's settings on its model", () => {
    expect(simpleProviderConfig(tuned()).models).toEqual([
      {
        id: DEFAULT_LEARN_NORMAL_MODEL,
        label: 'Normal',
        tier: 'normal',
        effort: 'high',
        maxOutputTokens: 12_000,
        providerOrder: ['deepseek'],
      },
    ]);
    // Power's suggestions and Tangent credit, Normal and Max, don't take them (the user picks there).
    expect(suggestedModels(tuned()).every((m) => !('effort' in m))).toBe(true);
    const credit = builtInPowerConfig(tuned()).models;
    expect(credit.map((m) => m.id)).toEqual([DEFAULT_LEARN_NORMAL_MODEL, DEFAULT_POWER_MAX_MODEL]);
    expect(credit.every((m) => !('effort' in m || 'providerOrder' in m))).toBe(true);
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
    expect(simpleChatSettings(tuned(), 'openrouter').summaryEffort).toBe('none');
    expect(simpleChatSettings(deployed(), 'openrouter').summaryEffort).toBe('low');
  });

  it('ask Haiku at high effort on Anthropic’s own endpoint by default, fallbacks allowed', async () => {
    const config = simpleProviderConfig(deployed());
    expect(config.models).toEqual([
      {
        id: DEFAULT_LEARN_NORMAL_MODEL,
        label: 'Normal',
        tier: 'normal',
        effort: 'high',
        maxOutputTokens: 16_384,
        providerOrder: HAIKU_PINNED,
      },
    ]);
    expect(DEFAULT_LEARN_NORMAL_MODEL).toBe('anthropic/claude-haiku-5.5');
    const normal = await sentBody(config, { model: DEFAULT_LEARN_NORMAL_MODEL });
    expect(normal).toMatchObject({
      reasoning: { effort: 'high' },
      provider: { order: HAIKU_PINNED, allow_fallbacks: true },
    });
  });

  it("ask another model with its own defaults: the default model's settings stay with it", async () => {
    const config = simpleProviderConfig(deployed({ LEARN_NORMAL_MODEL: 'minimax/minimax-m3' }));
    expect(config.models).toEqual([{ id: 'minimax/minimax-m3', label: 'Normal', tier: 'normal' }]);
    const body = await sentBody(config, { model: 'minimax/minimax-m3' });
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('provider');
  });
});

describe("the open pool runs Normal's request settings, within its own caps", () => {
  it("asks Haiku as Normal does: high effort, Anthropic's endpoint, merged with max_price", async () => {
    const e = deployed();
    const pool = await resolvePoolParams(e, null);
    expect(pool.model).toBe(DEFAULT_LEARN_NORMAL_MODEL);
    const config = poolProviderConfig(e, pool);
    const normal = simpleProviderConfig(e).models[0]!;
    // Normal's listing as it is, but for the pool's reply cap.
    expect(config.models).toEqual([{ ...normal, maxOutputTokens: pool.maxOutputTokens }]);
    expect(config).toMatchObject({
      defaultModel: DEFAULT_LEARN_NORMAL_MODEL,
      openModels: false,
      maxContextTokens: pool.maxInputTokens + pool.maxOutputTokens,
      maxOutputTokens: pool.maxOutputTokens,
    });
    const body = await sentBody(config, { model: pool.model });
    expect(body['reasoning']).toEqual({ effort: 'high' });
    // OpenRouter's leg keeps the pool's max_price, at Haiku's $0.10 / $0.50 per MTok.
    expect(body['provider']).toEqual({
      order: HAIKU_PINNED,
      allow_fallbacks: true,
      max_price: { prompt: 0.1, completion: 0.5 },
    });
    // Summaries and titles at the background effort, as on credit.
    expect(poolChatSettings(pool).summaryEffort).toBe('low');
    expect(poolChatSettings(pool).summaryModel).toBe(DEFAULT_LEARN_NORMAL_MODEL);
  });

  it("follows Normal's vars: another model, effort and pinning move the pool with it", async () => {
    const e = deployed({
      LEARN_NORMAL_MODEL: 'minimax/minimax-m3',
      LEARN_NORMAL_EFFORT: 'low',
      LEARN_NORMAL_PROVIDER_ORDER: 'novita',
      BACKGROUND_EFFORT: 'none',
    });
    const pool = await resolvePoolParams(e, null);
    expect(pool.model).toBe('minimax/minimax-m3');
    expect(pool.price).toMatchObject({ inMicrosPerMTok: 300_000, outMicrosPerMTok: 1_200_000 });
    const body = await sentBody(poolProviderConfig(e, pool), { model: pool.model });
    expect(body['reasoning']).toEqual({ effort: 'low' });
    expect(body['provider']).toEqual({
      order: ['novita'],
      allow_fallbacks: true,
      max_price: { prompt: 0.3, completion: 1.2 },
    });
    // A call that asks for no thinking (a summary at `none`) turns it off whatever Normal's effort.
    const unthinking = await sentBody(poolProviderConfig(e, pool), {
      model: pool.model,
      reasoning: 'none',
    });
    expect(unthinking['reasoning']).toEqual({ enabled: false });
    expect(poolChatSettings(pool).summaryEffort).toBe('none');
  });

  it("replies with as much room as credit's Normal, and a reply's ceiling fits each daily cap", async () => {
    // As shipped: the pool's caps are the code defaults (the test bindings lower them).
    const pool = await resolvePoolParams(asShipped(), null);
    expect(pool.maxOutputTokens).toBe(BUILT_IN_MAX_OUTPUT_TOKENS);
    const ceiling = replyCeilingMicros(pool, pool.price!);
    // About 1.7 cents at Haiku's prices: under the $0.10 per user and $0.30 per network a day.
    expect(ceiling).toBeGreaterThan(15_000);
    expect(ceiling).toBeLessThan(20_000);
    expect(ceiling).toBeLessThanOrEqual(pool.caps.user.spendMicrosPerDay);
    expect(ceiling).toBeLessThanOrEqual(pool.caps.ip.spendMicrosPerDay);
  });
});

describe('MiniMax M3, a config-only fallback', () => {
  it('is priced (so Normal, and with it the pool, may run it) but no default', () => {
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
