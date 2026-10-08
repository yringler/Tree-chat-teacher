// Real context windows of OpenRouter models (model-windows.ts): synced daily
// with the prices into `model_windows`, and used for the budget of any
// OpenRouter model whose provider config names no window, never above a
// configured one (Tangent credit's, the pool's).
import { createProviderRegistry } from '@tangent/providers';
import type { InputBudgetResponse, ProviderConfig, TreeDetail } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { chargeMicros } from '../src/billing/pricing.js';
import { appConfig } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import {
  modelWindow,
  parseModelWindows,
  syncModelWindows,
  withModelWindows,
  withWindow,
  type ModelWindow,
} from '../src/model-windows.js';
import { syncModelPrices } from '../src/pool/model-prices.js';
import { simpleMaxInputTokens, SIMPLE_MAX_OUTPUT_TOKENS } from '../src/simple-mode.js';
import { envWithFailingDb } from './mocks/billing-helpers.js';

const env = rawEnv as unknown as AppEnv;
const T0 = new Date('2026-01-01T03:23:00Z');
const T1 = new Date('2026-01-02T03:23:00Z');

/** A `GET /api/v1/models` body: id, context_length and top_provider.max_completion_tokens. */
function body(models: { id: string; context?: unknown; out?: unknown; price?: boolean }[]) {
  return {
    data: models.map((m) => ({
      id: m.id,
      pricing:
        m.price === false ? { prompt: '-1', completion: '-1' } : { prompt: '0', completion: '0' },
      context_length: m.context ?? null,
      top_provider: { context_length: m.context ?? null, max_completion_tokens: m.out ?? null },
    })),
  };
}

async function rows() {
  const { results } = await env.DB.prepare(
    'SELECT model, context_tokens AS ctx, max_output_tokens AS out, updated_at AS at FROM model_windows ORDER BY model',
  ).all<{ model: string; ctx: number; out: number | null; at: string }>();
  return results;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM model_windows'),
    env.DB.prepare('DELETE FROM model_prices'),
  ]);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('parseModelWindows', () => {
  it('keeps every listed model with a window, priced or not, and its output limit when reported', () => {
    const windows = parseModelWindows(
      body([
        { id: 'a/one', context: 1_000_000, out: 64_000 },
        { id: 'a/router', context: 2_000_000, price: false },
        { id: 'a/none' },
        { id: 'a/bad', context: -5 },
        { id: 'a/float', context: 1.5 },
      ]),
    );
    expect([...windows]).toEqual([
      ['a/one', { contextTokens: 1_000_000, maxOutputTokens: 64_000 }],
      ['a/router', { contextTokens: 2_000_000, maxOutputTokens: null }],
    ]);
    expect(() => parseModelWindows({})).toThrow(/no data array/);
  });
});

describe('syncModelWindows', () => {
  it('writes new and changed windows only, in chunks', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m/${i}`, context: 1000 + i }));
    expect(await syncModelWindows(env, T0, body(many))).toEqual({ listed: 60, changed: 60 });
    expect(await rows()).toHaveLength(60);

    const next = many.map((m, i) => (i === 7 ? { ...m, context: 9999, out: 100 } : m));
    expect(await syncModelWindows(env, T1, body(next))).toEqual({ listed: 60, changed: 1 });
    const stored = await rows();
    expect(stored.find((r) => r.model === 'm/7')).toEqual({
      model: 'm/7',
      ctx: 9999,
      out: 100,
      at: T1.toISOString(),
    });
    expect(stored.find((r) => r.model === 'm/8')?.at).toBe(T0.toISOString());
  });

  it('runs with the daily price sync, from the same list; its failure leaves the prices stored', async () => {
    const fetchImpl = (async () =>
      Response.json(body([{ id: 'x/any', context: 300_000, out: 8000 }]))) as typeof fetch;
    await syncModelPrices(env, T0, fetchImpl);
    expect(await rows()).toEqual([
      { model: 'x/any', ctx: 300_000, out: 8000, at: T0.toISOString() },
    ]);

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = envWithFailingDb(env, /model_windows/);
    await expect(syncModelPrices(broken, T1, fetchImpl)).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith(
      'Model window sync failed; the stored windows stay',
      expect.any(Error),
    );
  });
});

describe('modelWindow', () => {
  it('a priced model: its price entry’s window, with the synced output limit', async () => {
    // `simple` is priced with a 1,048,576-token window (vitest.config.ts MODEL_PRICES): a larger
    // synced window never raises it.
    await syncModelWindows(env, T0, body([{ id: 'normal', context: 2_000_000, out: 4000 }]));
    expect(await modelWindow(env, 'normal')).toEqual({
      contextTokens: 1_048_576,
      maxOutputTokens: 4000,
    });
  });

  it('any other model: its synced window, else unknown', async () => {
    await syncModelWindows(env, T0, body([{ id: 'x/big', context: 500_000 }]));
    expect(await modelWindow(env, 'x/big')).toEqual({
      contextTokens: 500_000,
      maxOutputTokens: null,
    });
    expect(await modelWindow(env, 'x/unknown')).toBeNull();
  });

  it('a failed read is unknown, not an error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await modelWindow(envWithFailingDb(env, /model_windows/), 'x/big')).toBeNull();
    expect(error).toHaveBeenCalled();
  });
});

describe('withWindow', () => {
  const base = {
    maxContextTokens: 128_000,
    maxOutputTokens: 32_000,
    supportsSystemPrompt: true,
    supportsTokenCount: false,
    supportsWebSearch: false,
  };

  it('replaces a default window with the real one, larger or smaller', () => {
    const real = (contextTokens: number): ModelWindow => ({ contextTokens, maxOutputTokens: null });
    expect(withWindow(base, real(1_000_000), false).maxContextTokens).toBe(1_000_000);
    expect(withWindow(base, real(32_768), false).maxContextTokens).toBe(32_768);
    expect(withWindow(base, null, false)).toBe(base);
  });

  it('only lowers a configured window and the output limit', () => {
    const configured = { ...base, maxContextTokens: 76_384 };
    expect(
      withWindow(configured, { contextTokens: 1_000_000, maxOutputTokens: 64_000 }, true),
    ).toMatchObject({ maxContextTokens: 76_384, maxOutputTokens: 32_000 });
    expect(
      withWindow(configured, { contextTokens: 32_768, maxOutputTokens: 8192 }, true),
    ).toMatchObject({ maxContextTokens: 32_768, maxOutputTokens: 8192 });
  });
});

describe('withModelWindows', () => {
  const openRouter: ProviderConfig = {
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'x/listed',
    models: [
      { id: 'x/listed', label: 'Listed' },
      { id: 'x/sized', label: 'Sized', maxContextTokens: 50_000 },
    ],
    openModels: true,
  };
  const other: ProviderConfig = {
    ...openRouter,
    id: 'other',
    baseUrl: 'https://api.example.com/v1',
  };

  it('looks up OpenRouter models once each; other providers pass through', async () => {
    const lookup = vi.fn(async (model: string) =>
      model === 'x/unknown' ? null : { contextTokens: 400_000, maxOutputTokens: null },
    );
    const configs = [openRouter, other];
    const registry = withModelWindows(
      createProviderRegistry(configs, { secrets: {} }),
      configs,
      env,
      lookup,
    );
    const or = registry.get('openrouter')!;
    expect(or).toBe(registry.get('openrouter'));
    expect((await or.resolveCapabilities!('x/listed')).maxContextTokens).toBe(400_000);
    expect((await or.resolveCapabilities!('x/listed')).maxContextTokens).toBe(400_000);
    expect((await or.resolveCapabilities!('any/model')).maxContextTokens).toBe(400_000);
    // A window the config names is never raised.
    expect((await or.resolveCapabilities!('x/sized')).maxContextTokens).toBe(50_000);
    // Unknown: the kind's default stays.
    expect((await or.resolveCapabilities!('x/unknown')).maxContextTokens).toBe(128_000);
    expect(lookup.mock.calls.map((c) => c[0])).toEqual([
      'x/listed',
      'any/model',
      'x/sized',
      'x/unknown',
    ]);
    expect(registry.get('other')?.resolveCapabilities).toBeUndefined();
  });
});

describe('the input budget of an OpenRouter branch', () => {
  /** The dev bypass's power account, with OpenRouter on the own key and as Tangent credit. */
  const OPENROUTER = {
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeySecret: 'OPENROUTER_API_KEY',
    defaultModel: 'x/big',
    models: [{ id: 'x/big', label: 'Big' }],
    openModels: true,
  };
  const e: AppEnv = {
    ...env,
    PROVIDERS: JSON.stringify([OPENROUTER]),
    OPENROUTER_API_KEY: 'sk-or-own',
    SIMPLE_PROVIDER: JSON.stringify({
      ...OPENROUTER,
      label: 'Tangent',
      apiKeySecret: 'OPENROUTER_SIMPLE_API_KEY',
      models: [{ id: 'x/big', label: 'Normal', tier: 'normal' }],
    }),
    PERSONAL_CREDIT_ENABLED: 'true',
    MODEL_PRICES: JSON.stringify({
      normal: { in: 1_000_000, out: 1_000_000, context: 8_192 },
      'x/priced': { in: 2_000_000, out: 8_000_000, cacheRead: 200_000, context: 400_000 },
    }),
  };
  const app = createApp();
  const call = (path: string, json?: unknown) =>
    app.request(
      `https://tangent.example.com${path}`,
      json === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(json),
          },
      e,
    );

  async function budget(route: Record<string, string>): Promise<InputBudgetResponse> {
    const res = await call('/api/trees', { title: 'W', ...route });
    expect(res.status, await res.clone().text()).toBe(201);
    const { tree } = (await res.json()) as TreeDetail;
    const got = await call(`/api/branches/${tree.trunkBranchId}/input-budget`);
    expect(got.status, await got.clone().text()).toBe(200);
    return (await got.json()) as InputBudgetResponse;
  }

  it('on the own key: the real window, the price entry’s for a priced model', async () => {
    await syncModelWindows(
      env,
      T0,
      body([
        { id: 'x/big', context: 500_000 },
        { id: 'x/small', context: 32_000, out: 4000 },
        { id: 'x/priced', context: 1_000_000 },
      ]),
    );
    expect(await budget({ providerId: 'openrouter', model: 'x/big' })).toMatchObject({
      contextTokens: 500_000,
      serverMaxInputTokens: null,
      price: null,
    });
    expect(await budget({ providerId: 'openrouter', model: 'x/small' })).toMatchObject({
      contextTokens: 32_000,
      maxOutputTokens: 4000,
    });
    // Not listed: the kind's default.
    expect(await budget({ providerId: 'openrouter', model: 'x/new' })).toMatchObject({
      contextTokens: 128_000,
    });
    // Priced: the entry's window, and OpenRouter's list price, which it bills the key directly.
    expect(await budget({ providerId: 'openrouter', model: 'x/priced' })).toMatchObject({
      contextTokens: 400_000,
      price: { inputUsdPerMTok: 2, cacheReadUsdPerMTok: 0.2, basis: 'list' },
    });
  });

  it('on Tangent credit: never above credit’s own window, and what credit charges', async () => {
    await syncModelWindows(
      env,
      T0,
      body([
        { id: 'x/big', context: 500_000 },
        { id: 'x/small', context: 32_000 },
      ]),
    );
    const creditWindow = simpleMaxInputTokens(e) + SIMPLE_MAX_OUTPUT_TOKENS;
    expect(
      await budget({ providerId: 'openrouter', funding: 'credit', model: 'x/big' }),
    ).toMatchObject({ contextTokens: creditWindow, serverMaxInputTokens: 60_000 });
    expect(
      await budget({ providerId: 'openrouter', funding: 'credit', model: 'x/small' }),
    ).toMatchObject({ contextTokens: 32_000 });

    const { markupBps, openRouterFeeBps } = appConfig(e).billing;
    const charged = (micros: number) =>
      chargeMicros(micros * 1000, markupBps, openRouterFeeBps) / 1e6;
    const priced = await budget({ providerId: 'openrouter', funding: 'credit', model: 'x/priced' });
    expect(priced.price).toEqual({
      inputUsdPerMTok: charged(2_000_000),
      cacheReadUsdPerMTok: charged(200_000),
      basis: 'credit',
    });
    // The list price × (1 + fee) × (1 + markup): 10% and 5.5% here.
    expect(priced.price?.inputUsdPerMTok).toBeCloseTo(2 * 1.055 * 1.1, 6);
  });
});
