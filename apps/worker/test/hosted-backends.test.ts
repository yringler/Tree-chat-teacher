import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chargeMicros, OPENROUTER_PROVIDER_ID, type GenerateRequest } from '@tangent/shared';
import { grantCredit } from '../src/billing/ledger.js';
import { meteredRegistry } from '../src/billing/meter.js';
import { createUsageMeter } from '../src/billing/personal-meter.js';
import type { AppEnv, LearnAccount } from '../src/env.js';
import { anthropicBackend } from '../src/hosted/anthropic.js';
import { hostedLegs, legConfig } from '../src/hosted/legs.js';
import { openRouterBackend } from '../src/hosted/openrouter.js';
import { hostedBackend, hostedChain, usageBackend } from '../src/hosted/registry.js';
import { creditPrice } from '../src/pool/model-prices.js';
import { poolFeeBps, resolvePoolParams } from '../src/pool/params.js';
import { costFromTokensNanos } from '../src/pool/pricing.js';
import { registryFor } from '../src/registries.js';
import { poolProviderConfig, simpleProviderConfig } from '../src/simple-mode.js';
import { createProviderRegistry } from '@tangent/providers';
import { providerEnv } from '../src/provider-configs.js';
import {
  devPowerAccount,
  ensureUser,
  powerAccount,
  scriptGeneration,
  simpleAccount,
  uniq,
  usageRows,
} from './mocks/billing-helpers.js';

const HAIKU = 'anthropic/claude-haiku-5.5';
const SONNET = 'anthropic/claude-sonnet-5.5';
const FLASH = 'deepseek/deepseek-v4.1-flash';

/** The default built-in provider (OpenRouter), on the operator's OpenRouter key. */
const env = {
  ...(rawEnv as unknown as AppEnv),
  BUILT_IN_PROVIDER: '',
  BUILT_IN_API_KEY: 'sk-or-operator',
  BUILT_IN_BACKENDS: '',
  BUILT_IN_ANTHROPIC_API_KEY: '',
} as AppEnv;
/** Anthropic first, then OpenRouter, both with their keys. */
const both = {
  ...env,
  BUILT_IN_BACKENDS: 'anthropic,openrouter',
  BUILT_IN_ANTHROPIC_API_KEY: 'sk-ant-operator',
} as AppEnv;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the OpenRouter backend', () => {
  it('serves every logical model under its own id', () => {
    expect(openRouterBackend.modelId(HAIKU)).toBe(HAIKU);
    expect(openRouterBackend.modelId(FLASH)).toBe(FLASH);
    expect(openRouterBackend.modelId('some-lab/new-model')).toBe('some-lab/new-model');
  });

  it('reports costs and looks generations up', () => {
    expect(openRouterBackend.cost).toBe('reported');
    expect(openRouterBackend.fetchGeneration).not.toBeNull();
  });

  it('charges the pool OpenRouter’s credit-purchase fee, unless the price entry sets one', () => {
    const e = { ...env, OPENROUTER_FEE_BPS: '550' } as AppEnv;
    expect(openRouterBackend.feeBps(e, {})).toBe(550);
    expect(openRouterBackend.feeBps(e, { feeBps: 300 })).toBe(300);
    expect(poolFeeBps(e, 'any/model', {})).toBe(550);
  });

  it('is the endpoint of the built-in provider', () => {
    const config = simpleProviderConfig(env);
    expect(config.id).toBe(OPENROUTER_PROVIDER_ID);
    expect(config).toMatchObject(openRouterBackend.config());
  });

  it('looks a generation’s cost up on the built-in key', async () => {
    const gen = uniq('gen-backend');
    await scriptGeneration(gen, [{ costUsd: 0.0042 }]);
    const key = openRouterBackend.apiKey({ ...env, BUILT_IN_API_KEY: 'sk-or-backend' } as AppEnv);
    expect(key).toBe('sk-or-backend');
    const cost = await openRouterBackend.fetchGeneration(gen, key!);
    expect(cost?.costUsd).toBe(0.0042);
  });
});

describe('the Anthropic backend', () => {
  it('serves the Claude models it maps, under Anthropic’s ids, and nothing else', () => {
    expect(anthropicBackend.modelId(HAIKU)).toBe('claude-haiku-5-5');
    expect(anthropicBackend.modelId(SONNET)).toBe('claude-sonnet-5-5');
    expect(anthropicBackend.modelId(FLASH)).toBeNull();
    expect(anthropicBackend.modelId('anthropic/claude-opus-9.9')).toBeNull();
    expect(anthropicBackend.modelId('claude-haiku-5-5')).toBeNull();
  });

  it('is charged by tokens, has no generations to look up and no pool fee', () => {
    expect(anthropicBackend.cost).toBe('tokens');
    expect(anthropicBackend.fetchGeneration).toBeNull();
    expect(anthropicBackend.feeBps(both, { feeBps: 300 })).toBe(0);
  });

  it('spends BUILT_IN_ANTHROPIC_API_KEY, never ANTHROPIC_API_KEY', () => {
    expect(anthropicBackend.apiKey(both)).toBe('sk-ant-operator');
    const devOnly = { ...env, ANTHROPIC_API_KEY: 'sk-ant-dev' } as AppEnv;
    expect(anthropicBackend.apiKey(devOnly)).toBeNull();
    expect(anthropicBackend.config()).toEqual({
      kind: 'anthropic',
      apiKeySecret: 'BUILT_IN_ANTHROPIC_API_KEY',
      options: { webSearch: true },
    });
  });
});

describe('the chain of a built-in call', () => {
  const chain = (e: AppEnv, model: string) =>
    hostedChain(e, model).map(({ backend, model: id }) => [backend.id, id]);

  it('is OpenRouter alone by default', () => {
    expect(chain(env, HAIKU)).toEqual([['openrouter', HAIKU]]);
    expect(hostedBackend('openrouter')).toBe(openRouterBackend);
    expect(hostedBackend('anthropic')).toBe(anthropicBackend);
  });

  it('runs a Claude model on Anthropic first when it is listed first', () => {
    expect(chain(both, HAIKU)).toEqual([
      ['anthropic', 'claude-haiku-5-5'],
      ['openrouter', HAIKU],
    ]);
    expect(usageBackend(both, HAIKU)).toEqual({
      backend: 'anthropic',
      backendModel: 'claude-haiku-5-5',
    });
  });

  it('runs a model Anthropic can’t serve on OpenRouter, even with Anthropic listed first', () => {
    expect(chain(both, FLASH)).toEqual([['openrouter', FLASH]]);
    const anthropicOnly = { ...both, BUILT_IN_BACKENDS: 'anthropic' } as AppEnv;
    expect(chain(anthropicOnly, FLASH)).toEqual([['openrouter', FLASH]]);
    expect(chain(anthropicOnly, HAIKU)).toEqual([['anthropic', 'claude-haiku-5-5']]);
  });

  it('skips a backend without its key', () => {
    const noKey = { ...both, BUILT_IN_ANTHROPIC_API_KEY: ' ' } as AppEnv;
    expect(chain(noKey, HAIKU)).toEqual([['openrouter', HAIKU]]);
    const neither = { ...noKey, BUILT_IN_API_KEY: '' } as AppEnv;
    // Nothing can serve it: OpenRouter, whose provider reports itself unavailable.
    expect(chain(neither, HAIKU)).toEqual([['openrouter', HAIKU]]);
  });

  it('is the BUILT_IN_PROVIDER override alone when one is set', () => {
    const override = {
      ...both,
      BUILT_IN_PROVIDER: (rawEnv as unknown as AppEnv).BUILT_IN_PROVIDER,
    } as AppEnv;
    expect(chain(override, HAIKU)).toEqual([['openrouter', HAIKU]]);
  });
});

/** An SSE response of `events` (`[event, data]`). */
function sse(events: [string, unknown][]): Response {
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** Anthropic's stream of a reply that read and wrote the cache and ran two searches. */
const ANTHROPIC_REPLY = (): Response =>
  sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 1_000,
            cache_read_input_tokens: 4_000,
            cache_creation_input_tokens: 2_000,
            output_tokens: 1,
          },
        },
      },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
    ],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 300, server_tool_use: { web_search_requests: 2 } },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]);

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** Answers api.anthropic.com with `reply`, records every request, and fails all others. */
function upstream(reply: () => Response): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    sent.push({
      url: request.url,
      headers: request.headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    });
    if (new URL(request.url).origin === 'https://api.anthropic.com') return reply();
    return new Response('not here', { status: 418 });
  });
  return sent;
}

function replyRequest(model: string, webSearch = true): GenerateRequest {
  return {
    model,
    system: 'You teach.',
    messages: [{ role: 'user', content: 'What is a monad?' }],
    maxOutputTokens: 1_000,
    signal: new AbortController().signal,
    usageTag: { purpose: 'reply', treeId: 'tree_1', branchId: 'branch_1', nodeId: uniq('node') },
    ...(webSearch ? { webSearch: { mode: 'auto' as const, maxUses: 2 } } : {}),
  };
}

async function fundedLearner(e: AppEnv): Promise<LearnAccount> {
  const account = simpleAccount();
  await ensureUser(e, account.userId!);
  await grantCredit(e.DB, {
    accountId: account.billingAccountId,
    kind: 'adjustment',
    amountMicros: 5_000_000,
    providerRef: `test-funds:${account.billingAccountId}`,
  });
  return account;
}

describe('the legs of a built-in call', () => {
  it('sends an Anthropic leg to Anthropic on the operator’s key, by Anthropic’s id, with the tier’s effort and native search', async () => {
    const sent = upstream(ANTHROPIC_REPLY);
    const outer = registryFor(both, await fundedLearner(both)).get(OPENROUTER_PROVIDER_ID)!;
    const legs = hostedLegs(both)(outer, HAIKU);
    expect(legs.map((l) => [l.backend.id, l.model, l.provider.kind])).toEqual([
      ['anthropic', 'claude-haiku-5-5', 'anthropic'],
      ['openrouter', HAIKU, 'openai-compatible'],
    ]);
    // The OpenRouter leg is the built-in provider itself.
    expect(legs[1]!.provider).toBe(outer);
    const events = [];
    for await (const e of legs[0]!.provider.stream({
      ...replyRequest(HAIKU),
      model: legs[0]!.model,
    }))
      events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent[0]!.headers.get('x-api-key')).toBe('sk-ant-operator');
    expect(sent[0]!.body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 1_000,
      output_config: { effort: 'high' },
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    });
    // OpenRouter's routing stays behind.
    expect(sent[0]!.body).not.toHaveProperty('provider');
  });

  it('leaves the pool’s max_price and pinned hosts on OpenRouter’s leg', async () => {
    const e = { ...both, POOL_MODEL: HAIKU } as AppEnv;
    const pool = await resolvePoolParams(e, null);
    const config = poolProviderConfig(e, pool);
    expect(config.options?.['extraBody']).toMatchObject({ provider: { max_price: {} } });
    const outer = createProviderRegistry([config], providerEnv(e, [config])).get(config.id)!;
    const leg = legConfig(outer, HAIKU, anthropicBackend, 'claude-haiku-5-5');
    expect(leg).toMatchObject({
      id: OPENROUTER_PROVIDER_ID,
      kind: 'anthropic',
      apiKeySecret: 'BUILT_IN_ANTHROPIC_API_KEY',
      options: { webSearch: true },
      defaultModel: 'claude-haiku-5-5',
      maxOutputTokens: pool.maxOutputTokens,
    });
    expect(leg.options).not.toHaveProperty('extraBody');
    expect(leg.models).toEqual([{ id: 'claude-haiku-5-5', label: expect.any(String) }]);
    expect(leg.baseUrl).toBeUndefined();
  });

  it('runs DeepSeek on OpenRouter even with Anthropic listed first', async () => {
    const sent = upstream(() => new Response('unused', { status: 500 }));
    const account = await fundedLearner(both);
    const registry = meteredRegistry(
      registryFor(both, account),
      createUsageMeter(both, account, () => undefined),
      () => true,
      hostedLegs(both),
    );
    const events = [];
    for await (const e of registry.get(OPENROUTER_PROVIDER_ID)!.stream(replyRequest(FLASH, false)))
      events.push(e);
    expect(sent.map((s) => new URL(s.url).origin)).toEqual(['https://openrouter.ai']);
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer sk-or-operator');
    expect(sent[0]!.body).toMatchObject({ model: FLASH });
    const [row] = await usageRows(both, account.billingAccountId);
    expect(row).toMatchObject({ model: FLASH, backend: 'openrouter', backend_model: FLASH });
  });
});

describe('a credit call on the Anthropic backend', () => {
  it('records the backend, keeps the logical model, and settles by tokens at its price with cache and search fees', async () => {
    const sent = upstream(ANTHROPIC_REPLY);
    const account = await fundedLearner(both);
    const deferred: Promise<unknown>[] = [];
    const registry = meteredRegistry(
      registryFor(both, account),
      createUsageMeter(both, account, (p) => deferred.push(p)),
      () => true,
      hostedLegs(both),
    );
    const events = [];
    for await (const e of registry.get(OPENROUTER_PROVIDER_ID)!.stream(replyRequest(HAIKU)))
      events.push(e);
    await Promise.allSettled(deferred);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(sent.map((s) => s.url)).toEqual(['https://api.anthropic.com/v1/messages']);

    const price = (await creditPrice(both, HAIKU))!;
    // Claude's cache writes cost more than its input: the premium is in the price.
    expect(price.cacheWriteMicrosPerMTok).toBeGreaterThan(price.inMicrosPerMTok);
    const costNanos =
      costFromTokensNanos(price, 7_000, 300, { readTokens: 4_000, writeTokens: 2_000 }) +
      2 * 10_000 * 1000;
    const [row] = await usageRows(both, account.billingAccountId);
    expect(row).toMatchObject({
      status: 'settled',
      provider_id: OPENROUTER_PROVIDER_ID,
      model: HAIKU,
      backend: 'anthropic',
      backend_model: 'claude-haiku-5-5',
      settle_reason: 'tokens',
      generation_id: null,
      input_tokens: 7_000,
      output_tokens: 300,
      web_searches: 2,
      cost_nanos: costNanos,
      charge_micros: chargeMicros(costNanos, 0, 0),
    });
    // Held for both searches at Anthropic's fee, above the tokens' own worst case.
    expect(row!.hold_micros).toBeGreaterThan(20_000);
  });
});

describe('own keys never reach the hosted backends', () => {
  it('Learn on its own OpenRouter key stays on OpenRouter with that key, unmetered', async () => {
    const sent = upstream(ANTHROPIC_REPLY);
    const account: LearnAccount = { ...(await fundedLearner(both)), payer: 'own-key' };
    const own = registryFor(both, account, { [OPENROUTER_PROVIDER_ID]: 'sk-or-learner' });
    for await (const _ of own.get(OPENROUTER_PROVIDER_ID)!.stream(replyRequest(HAIKU)));
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).origin).toBe('https://openrouter.ai');
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer sk-or-learner');
    expect(sent[0]!.body).toMatchObject({ model: HAIKU });
    expect(await usageRows(both, account.billingAccountId)).toEqual([]);
  });

  it('power’s own-key providers can’t name the operator’s Anthropic key, even in the dev bypass', () => {
    const e = {
      ...both,
      PROVIDERS: JSON.stringify([
        {
          id: 'anthropic',
          kind: 'anthropic',
          label: 'Anthropic',
          apiKeySecret: 'BUILT_IN_ANTHROPIC_API_KEY',
          defaultModel: 'claude-haiku-5-5',
          models: [{ id: 'claude-haiku-5-5', label: 'Haiku' }],
        },
      ]),
    } as AppEnv;
    for (const account of [powerAccount(), devPowerAccount()]) {
      const [info] = registryFor(e, account).list();
      expect(info).toMatchObject({ id: 'anthropic', available: false, keySource: null });
    }
  });
});
