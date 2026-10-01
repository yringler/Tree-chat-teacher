import type {
  GenerateRequest,
  LlmProvider,
  ProviderEvent,
  ProviderInfo,
  ProviderRegistry,
  UsageTag,
} from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createUsageMeter, meteredRegistry, type UsageMeterOptions } from '../src/billing/meter.js';
import { chargeMicros, costUsdToNanos } from '../src/billing/pricing.js';
import type { AccountContext, AppEnv } from '../src/env.js';
import {
  envWithFailingDb,
  generationCalls,
  insertSubscription,
  scriptGeneration,
  simpleAccount,
  uniq,
  usageRows,
  type UsageRow,
} from './mocks/billing-helpers.js';

const env = {
  ...(rawEnv as unknown as AppEnv),
  OPENROUTER_SIMPLE_API_KEY: 'sk-or-simple-test',
} as AppEnv;
const FAST: UsageMeterOptions = { retryDelaysMs: [5, 5, 5, 5], settleRetryDelaysMs: [5, 5] };

/** A provider that plays a fixed event script (optionally pausing for a hook). */
function scriptedProvider(
  script: ProviderEvent[],
  onEvent?: (index: number) => Promise<void>,
): LlmProvider & { calls: number } {
  const provider = {
    id: 'tangent',
    kind: 'fake' as const,
    label: 'Tangent',
    calls: 0,
    models: () => [{ id: 'smart', label: 'Smart' }],
    defaultModel: () => 'smart',
    capabilities: () => ({
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      supportsSystemPrompt: true,
      supportsTokenCount: true,
    }),
    countTokens: () => Promise.resolve(42),
    async *stream(): AsyncIterable<ProviderEvent> {
      provider.calls++;
      for (let i = 0; i < script.length; i++) {
        await onEvent?.(i);
        yield script[i]!;
      }
    },
  };
  return provider as LlmProvider & { calls: number };
}

function registryOf(provider: LlmProvider): ProviderRegistry {
  const info: ProviderInfo = {
    id: provider.id,
    kind: provider.kind,
    label: provider.label,
    models: provider.models(),
    defaultModel: provider.defaultModel(),
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

function request(tag?: UsageTag, signal = new AbortController().signal): GenerateRequest {
  return {
    model: 'smart',
    system: null,
    messages: [{ role: 'user', content: 'hi' }],
    maxOutputTokens: 100,
    signal,
    ...(tag ? { usageTag: tag } : {}),
  };
}

interface Harness {
  account: AccountContext;
  deferred: Promise<unknown>[];
  run(
    script: ProviderEvent[],
    opts?: { tag?: UsageTag; env?: AppEnv; options?: UsageMeterOptions; stopAfter?: number },
  ): Promise<ProviderEvent[]>;
  rows(): Promise<UsageRow[]>;
  settleBackground(): Promise<void>;
}

function harness(account: AccountContext = simpleAccount()): Harness {
  const deferred: Promise<unknown>[] = [];
  return {
    account,
    deferred,
    async run(script, opts = {}) {
      const meter = createUsageMeter(
        opts.env ?? env,
        account,
        (p) => deferred.push(p),
        opts.options ?? FAST,
      );
      const registry = meteredRegistry(registryOf(scriptedProvider(script)), meter);
      const out: ProviderEvent[] = [];
      for await (const event of registry.get('tangent')!.stream(request(opts.tag))) {
        out.push(event);
        if (opts.stopAfter !== undefined && out.length >= opts.stopAfter) break;
      }
      return out;
    },
    rows: () => usageRows(env, account.id),
    async settleBackground() {
      // Deferred work may defer more work; drain until stable.
      for (let seen = -1; seen !== deferred.length;) {
        seen = deferred.length;
        await Promise.allSettled(deferred);
      }
    },
  };
}

const COST = 0.001234;
const tag: UsageTag = { purpose: 'reply', treeId: 'tree_1', nodeId: 'node_1' };

describe('usage meter', () => {
  it('settles cost × 1.10 inline (no subscription), with tokens, tag and generation id', async () => {
    const h = harness();
    const gen = uniq('gen');
    const events = await h.run(
      [
        { type: 'billing', generationId: gen },
        { type: 'delta', text: 'Hello' },
        { type: 'usage', usage: { inputTokens: 12 } },
        { type: 'usage', usage: { outputTokens: 34 } },
        { type: 'billing', generationId: gen, costUsd: COST },
        { type: 'done', stopReason: 'stop' },
      ],
      { tag },
    );
    expect(events.map((e) => e.type)).toEqual([
      'billing',
      'delta',
      'usage',
      'usage',
      'billing',
      'done',
    ]);
    // Settled before the terminal event was passed on.
    const [row] = await h.rows();
    expect(row).toMatchObject({
      status: 'settled',
      tree_id: 'tree_1',
      node_id: 'node_1',
      purpose: 'reply',
      provider_id: 'tangent',
      model: 'smart',
      hold_micros: 20_000,
      markup_bps: 1000,
      cost_nanos: 1_234_000,
      charge_micros: 1358, // ceil(1234 × 1.10)
      input_tokens: 12,
      output_tokens: 34,
    });
    expect(row!.settled_at).not.toBeNull();
    await h.settleBackground();
    expect((await h.rows())[0]!.generation_id).toBe(gen);
  });

  it('settles cost × 1.05 with an active subscription', async () => {
    const account = simpleAccount();
    await insertSubscription(env, account.userId!, 'active');
    const h = harness(account);
    await h.run([
      { type: 'delta', text: 'x' },
      { type: 'billing', generationId: uniq('gen'), costUsd: COST },
      { type: 'done', stopReason: 'stop' },
    ]);
    expect((await h.rows())[0]).toMatchObject({
      status: 'settled',
      markup_bps: 500,
      charge_micros: 1296,
    });
  });

  it('holds while the stream is in flight', async () => {
    const h = harness();
    let pendingSeen: UsageRow[] = [];
    const meter = createUsageMeter(env, h.account, (p) => h.deferred.push(p), FAST);
    const provider = scriptedProvider(
      [
        { type: 'delta', text: 'a' },
        { type: 'billing', costUsd: 0.5 },
        { type: 'done', stopReason: null },
      ],
      async (i) => {
        if (i === 1) pendingSeen = await h.rows();
      },
    );
    for await (const _ of meteredRegistry(registryOf(provider), meter)
      .get('tangent')!
      .stream(request()))
      void _;
    expect(pendingSeen).toHaveLength(1);
    expect(pendingSeen[0]).toMatchObject({
      status: 'pending',
      hold_micros: 20_000,
      charge_micros: null,
      purpose: 'other',
    });
    expect((await h.rows())[0]).toMatchObject({
      status: 'settled',
      charge_micros: chargeMicros(costUsdToNanos(0.5), 1000),
    });
  });

  it('settles at 0 when the call never reached the upstream (no generation id)', async () => {
    const h = harness();
    const events = await h.run([
      { type: 'error', error: { code: 'network', message: 'connect failed', retryable: true } },
    ]);
    expect(events.at(-1)?.type).toBe('error');
    expect((await h.rows())[0]).toMatchObject({
      status: 'settled',
      cost_nanos: 0,
      charge_micros: 0,
    });
  });

  it('reconciles an aborted run via /api/v1/generation (404, then 200)', async () => {
    const h = harness();
    const gen = uniq('gen-aborted');
    await scriptGeneration(gen, [
      { status: 404 },
      { costUsd: 0.002, inputTokens: 100, outputTokens: 7 },
    ]);
    const events = await h.run([
      { type: 'billing', generationId: gen },
      { type: 'delta', text: 'partial' },
      { type: 'error', error: { code: 'aborted', message: 'aborted', retryable: false } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'aborted' } });
    expect((await h.rows())[0]!.status).toBe('pending');

    await h.settleBackground();
    const [row] = await h.rows();
    expect(row).toMatchObject({
      status: 'settled',
      generation_id: gen,
      cost_nanos: 2_000_000,
      charge_micros: 2200,
      input_tokens: 100,
      output_tokens: 7,
    });
    const calls = await generationCalls(gen);
    expect(calls.count).toBe(2);
    expect(calls.authorizations.every((a) => a === 'Bearer sk-or-simple-test')).toBe(true);
  });

  it('leaves the row pending for the cron when the generation never shows up', async () => {
    const h = harness();
    const gen = uniq('gen-missing');
    await h.run([
      { type: 'billing', generationId: gen },
      { type: 'error', error: { code: 'aborted', message: 'aborted', retryable: false } },
    ]);
    await h.settleBackground();
    expect((await h.rows())[0]).toMatchObject({ status: 'pending', generation_id: gen });
    expect((await generationCalls(gen)).count).toBe(4);
  });

  it('uses the key named by SIMPLE_PROVIDER.apiKeySecret', async () => {
    const h = harness();
    const gen = uniq('gen-key');
    await scriptGeneration(gen, [{ costUsd: 0.001 }]);
    const custom = {
      ...env,
      SIMPLE_PROVIDER: JSON.stringify({
        id: 'tangent',
        kind: 'openai-compatible',
        label: 'T',
        apiKeySecret: 'MY_OR_KEY',
        models: [],
        defaultModel: 'm',
      }),
      MY_OR_KEY: 'sk-or-custom',
    } as AppEnv;
    await h.run(
      [
        { type: 'billing', generationId: gen },
        { type: 'done', stopReason: 'length' },
      ],
      { env: custom },
    );
    await h.settleBackground();
    expect((await h.rows())[0]).toMatchObject({ status: 'settled', charge_micros: 1100 });
    expect((await generationCalls(gen)).authorizations).toEqual(['Bearer sk-or-custom']);
  });

  it('finishes when the consumer stops reading early', async () => {
    const h = harness();
    await h.run(
      [
        { type: 'delta', text: 'a' },
        { type: 'delta', text: 'b' },
        { type: 'billing', costUsd: 1 },
        { type: 'done', stopReason: null },
      ],
      { stopAfter: 1 },
    );
    // No id, no cost when the consumer left: nothing billed upstream that we can see.
    expect((await h.rows())[0]).toMatchObject({ status: 'settled', charge_micros: 0 });
  });

  it('fails as an event (no upstream call) when the pending row cannot be written', async () => {
    const h = harness();
    const provider = scriptedProvider([{ type: 'done', stopReason: null }]);
    const broken = envWithFailingDb(env, /INSERT INTO usage_events/);
    const meter = createUsageMeter(broken, h.account, (p) => h.deferred.push(p), FAST);
    const events: ProviderEvent[] = [];
    for await (const e of meteredRegistry(registryOf(provider), meter)
      .get('tangent')!
      .stream(request()))
      events.push(e);
    expect(events).toEqual([
      { type: 'error', error: expect.objectContaining({ code: 'server', retryable: true }) },
    ]);
    expect(provider.calls).toBe(0);
    expect(await h.rows()).toEqual([]);
  });

  it('never throws into the stream when settling fails; the row stays pending', async () => {
    const h = harness();
    const broken = envWithFailingDb(env, /^\s*UPDATE/);
    const events = await h.run(
      [
        { type: 'billing', generationId: uniq('gen') },
        { type: 'delta', text: 'ok' },
        { type: 'billing', costUsd: COST },
        { type: 'done', stopReason: 'stop' },
      ],
      { env: broken },
    );
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
    // Background retries were scheduled; they fail too and never reject.
    expect(h.deferred.length).toBeGreaterThan(0);
    await h.settleBackground();
    expect((await Promise.allSettled(h.deferred)).every((r) => r.status === 'fulfilled')).toBe(
      true,
    );
    // The row stays pending (hold kept) for the cron.
    expect((await h.rows())[0]).toMatchObject({
      status: 'pending',
      generation_id: null,
      hold_micros: 20_000,
    });
  });

  it('passes the rest of the registry and provider through', async () => {
    const provider = scriptedProvider([]);
    const inner = registryOf(provider);
    const registry = meteredRegistry(
      inner,
      createUsageMeter(env, simpleAccount(), () => undefined),
    );
    expect(registry.list()).toEqual(inner.list());
    expect(registry.defaultProviderId()).toBe('tangent');
    expect(registry.get('nope')).toBeUndefined();
    const wrapped = registry.get('tangent')!;
    expect(registry.get('tangent')).toBe(wrapped);
    expect([wrapped.id, wrapped.kind, wrapped.label, wrapped.defaultModel()]).toEqual([
      'tangent',
      'fake',
      'Tangent',
      'smart',
    ]);
    expect(wrapped.capabilities('smart').maxOutputTokens).toBe(100);
    expect(await wrapped.countTokens!(request())).toBe(42);
  });
});
