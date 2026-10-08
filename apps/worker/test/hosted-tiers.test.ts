// How each hosted tier asks its model (docs/DECISIONS.md "Hosted tier
// config"): the `*_EFFORT`, `*_REPLY_TOKENS` and `*_PROVIDER_ORDER` vars of
// Learn's Normal and Max, the open pool and the background calls, and the
// request each one sends upstream. Every default is the behaviour before
// them: no effort, the default caps, no pinning.
import { createProviderRegistry } from '@tangent/providers';
import type { GenerateRequest, ProviderConfig } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig, effortVar } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { resolvePoolParams } from '../src/pool/params.js';
import {
  builtInPowerConfig,
  DEFAULT_SIMPLE_FAST_MODEL,
  DEFAULT_SIMPLE_MAX_MODEL,
  DEFAULT_SIMPLE_NORMAL_MODEL,
  poolChatSettings,
  poolProviderConfig,
  simpleChatSettings,
  simpleProviderConfig,
  suggestedModels,
} from '../src/simple-mode.js';
import { uniq } from './mocks/billing-helpers.js';

const env = rawEnv as unknown as AppEnv;
const TIER_VARS = [
  'SIMPLE_NORMAL_EFFORT',
  'SIMPLE_NORMAL_REPLY_TOKENS',
  'SIMPLE_NORMAL_PROVIDER_ORDER',
  'SIMPLE_MAX_EFFORT',
  'SIMPLE_MAX_REPLY_TOKENS',
  'SIMPLE_MAX_PROVIDER_ORDER',
  'SIMPLE_FAST_EFFORT',
  'POOL_EFFORT',
  'POOL_PROVIDER_ORDER',
] as const;
/** As deployed: the default OpenRouter config, every tier var empty unless overridden. */
const deployed = (overrides: Partial<AppEnv> = {}) =>
  ({
    ...env,
    SIMPLE_PROVIDER: '',
    SIMPLE_NORMAL_MODEL: '',
    SIMPLE_MAX_MODEL: '',
    SIMPLE_SMART_MODEL: '',
    SIMPLE_FAST_MODEL: '',
    POOL_MODEL: '',
    MODEL_PRICES: '',
    POOL_ACCOUNT_ID: uniq('pool'),
    ...Object.fromEntries(TIER_VARS.map((k) => [k, ''])),
    ...overrides,
  }) as AppEnv;

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
    secrets: { OPENROUTER_SIMPLE_API_KEY: 'sk-or-test' },
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

describe('tier config vars', () => {
  it('default to the behaviour before them', () => {
    const c = appConfig(deployed());
    const none = { effort: null, maxOutputTokens: null, providerOrder: [] };
    expect(c.simple.normal).toEqual(none);
    expect(c.simple.max).toEqual(none);
    expect(c.simple.backgroundEffort).toBeNull();
    expect(c.pool).toMatchObject({ effort: null, providerOrder: [] });
  });

  it('parse efforts, reply caps and provider orders', () => {
    const c = appConfig(
      deployed({
        SIMPLE_NORMAL_EFFORT: ' High ',
        SIMPLE_NORMAL_REPLY_TOKENS: '12000',
        SIMPLE_NORMAL_PROVIDER_ORDER: 'deepseek, novita ,',
        SIMPLE_MAX_EFFORT: 'low',
        SIMPLE_FAST_EFFORT: 'none',
        POOL_EFFORT: 'low',
        POOL_PROVIDER_ORDER: 'deepseek',
      }),
    );
    expect(c.simple.normal).toEqual({
      effort: 'high',
      maxOutputTokens: 12_000,
      providerOrder: ['deepseek', 'novita'],
    });
    expect(c.simple.max).toEqual({ effort: 'low', maxOutputTokens: null, providerOrder: [] });
    expect(c.simple.backgroundEffort).toBe('none');
    expect(c.pool).toMatchObject({ effort: 'low', providerOrder: ['deepseek'] });
  });

  it('refuses max (and anything else) as an effort, logging it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of ['max', 'xhigh', 'medium', 'off', 'minimal'])
      expect(effortVar('POOL_EFFORT', bad)).toBeNull();
    expect(error).toHaveBeenCalledTimes(5);
    expect(String(error.mock.calls[0]![0])).toMatch(/POOL_EFFORT=max/);
    expect(effortVar('POOL_EFFORT', undefined)).toBeNull();
    expect(effortVar('POOL_EFFORT', 'NONE')).toBe('none');
  });

  it('clamps a reply cap to the per-call bound (16,384), logging it; a bad one is the default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      appConfig(deployed({ SIMPLE_MAX_REPLY_TOKENS: '40000' })).simple.max.maxOutputTokens,
    ).toBe(16_384);
    expect(warn).toHaveBeenCalledWith('SIMPLE_MAX_REPLY_TOKENS=40000 is unsafe; using 16384');
    for (const bad of ['0', '-5', '1.5', 'lots'])
      expect(
        appConfig(deployed({ SIMPLE_MAX_REPLY_TOKENS: bad })).simple.max.maxOutputTokens,
      ).toBeNull();
  });
});

describe("Learn's tiers with request settings", () => {
  const tuned = () =>
    deployed({
      SIMPLE_NORMAL_EFFORT: 'high',
      SIMPLE_NORMAL_REPLY_TOKENS: '12000',
      SIMPLE_NORMAL_PROVIDER_ORDER: 'deepseek',
      SIMPLE_MAX_EFFORT: 'low',
      SIMPLE_FAST_EFFORT: 'none',
    });

  it("put each tier's settings on its model only", () => {
    expect(simpleProviderConfig(tuned()).models).toEqual([
      {
        id: DEFAULT_SIMPLE_NORMAL_MODEL,
        label: 'Normal',
        tier: 'normal',
        effort: 'high',
        maxOutputTokens: 12_000,
        providerOrder: ['deepseek'],
      },
      { id: DEFAULT_SIMPLE_MAX_MODEL, label: 'Max', tier: 'max', effort: 'low' },
    ]);
    // Power's suggestions and Tangent credit don't take them (the user picks there).
    expect(suggestedModels(tuned()).every((m) => !('effort' in m))).toBe(true);
    expect(builtInPowerConfig(tuned()).models.every((m) => !('effort' in m))).toBe(true);
  });

  it('cap the reply at the tier cap and send the effort and pinning upstream', async () => {
    const config = simpleProviderConfig(tuned());
    const registry = createProviderRegistry([config], { secrets: {} });
    expect(registry.get(config.id)!.capabilities(DEFAULT_SIMPLE_NORMAL_MODEL).maxOutputTokens).toBe(
      12_000,
    );
    const normal = await sentBody(config, { model: DEFAULT_SIMPLE_NORMAL_MODEL });
    expect(normal).toMatchObject({
      reasoning: { effort: 'high' },
      provider: { order: ['deepseek'], allow_fallbacks: true },
    });
    const max = await sentBody(config, { model: DEFAULT_SIMPLE_MAX_MODEL });
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
    expect(simpleChatSettings(deployed()).summaryEffort).toBeNull();
  });

  it('change nothing by default', async () => {
    const config = simpleProviderConfig(deployed());
    expect(config.models).toEqual([
      { id: DEFAULT_SIMPLE_NORMAL_MODEL, label: 'Normal', tier: 'normal' },
      { id: DEFAULT_SIMPLE_MAX_MODEL, label: 'Max', tier: 'max' },
    ]);
    const body = await sentBody(config, { model: DEFAULT_SIMPLE_NORMAL_MODEL });
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('provider');
  });
});

describe('the open pool with request settings', () => {
  it("asks the pool model with the pool's effort and pinning, merged with its max_price", async () => {
    const e = deployed({
      POOL_EFFORT: 'low',
      POOL_PROVIDER_ORDER: 'deepseek',
      SIMPLE_FAST_EFFORT: 'none',
      // A tier on the same model keeps its own settings off the pool.
      SIMPLE_NORMAL_MODEL: DEFAULT_SIMPLE_FAST_MODEL,
      SIMPLE_NORMAL_EFFORT: 'high',
    });
    const pool = await resolvePoolParams(e, null);
    const config = poolProviderConfig(e, pool);
    expect(config.models).toEqual([
      {
        id: DEFAULT_SIMPLE_FAST_MODEL,
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
    // The topic classifier turns thinking off whatever the pool's effort.
    const classifier = await sentBody(config, { model: pool.model, reasoning: 'none' });
    expect(classifier['reasoning']).toEqual({ enabled: false });
    expect(poolChatSettings(pool).summaryEffort).toBe('none');
  });

  it('keeps only max_price by default', async () => {
    const e = deployed();
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
    const tier = simpleProviderConfig(deployed({ SIMPLE_NORMAL_MODEL: 'minimax/minimax-m3' }));
    expect(tier.models[0]).toMatchObject({ id: 'minimax/minimax-m3', tier: 'normal' });
  });
});
