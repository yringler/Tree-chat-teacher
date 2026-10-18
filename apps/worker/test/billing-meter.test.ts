import {
  chargeMicros,
  costUsdToNanos,
  type GenerateRequest,
  type LlmProvider,
  type ProviderEvent,
  type ProviderInfo,
  type ProviderRegistry,
  type UsageTag,
} from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBalance, grantCredit } from '../src/billing/ledger.js';
import { meteredRegistry } from '../src/billing/meter.js';
import type { UsageMeterOptions } from '../src/billing/meter-run.js';
import { createUsageMeter } from '../src/billing/personal-meter.js';
import { reserveCreditReply, USAGE_HOLD_MICROS } from '../src/billing/service.js';
import { markDispatched, repriceReservation } from '../src/billing/usage-store.js';
import { costFromTokensNanos } from '../src/pool/pricing.js';
import type { AccountContext, AppEnv } from '../src/env.js';
import {
  ensureUser,
  envWithFailingDb,
  generationCalls,
  insertSubscription,
  powerAccount,
  scriptGeneration,
  simpleAccount,
  uniq,
  usageRow,
  usageRows,
  type UsageRow,
} from './mocks/billing-helpers.js';

const env = {
  ...(rawEnv as unknown as AppEnv),
  BUILT_IN_API_KEY: 'sk-or-simple-test',
} as AppEnv;
const FAST: UsageMeterOptions = { retryDelaysMs: [5, 5, 5, 5], settleRetryDelaysMs: [5, 5] };

/** A provider that plays a fixed event script (optionally pausing for a hook). */
function scriptedProvider(
  script: ProviderEvent[],
  onEvent?: (index: number) => Promise<void>,
): LlmProvider & { calls: number } {
  const provider = {
    id: 'openrouter',
    kind: 'fake' as const,
    label: 'Tangent',
    calls: 0,
    models: () => [{ id: 'max', label: 'Max', tier: 'max' }],
    defaultModel: () => 'max',
    capabilities: () => ({
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      supportsSystemPrompt: true,
      supportsTokenCount: true,
      supportsWebSearch: false,
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

const onlyBuiltIn = (providerId: string) => providerId === 'openrouter';

function request(tag?: UsageTag, signal = new AbortController().signal): GenerateRequest {
  return {
    model: 'max',
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

/** A meter harness on `account`, funded so each call's hold is covered. */
async function harness(account: AccountContext = simpleAccount()): Promise<Harness> {
  if (account.userId) await ensureUser(env, account.userId);
  await grantCredit(env.DB, {
    accountId: account.billingAccountId,
    kind: 'adjustment',
    amountMicros: 1_000_000,
    providerRef: `test-funds:${account.billingAccountId}`,
  });
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
      const registry = meteredRegistry(registryOf(scriptedProvider(script)), meter, onlyBuiltIn);
      const out: ProviderEvent[] = [];
      for await (const event of registry.get('openrouter')!.stream(request(opts.tag))) {
        out.push(event);
        if (opts.stopAfter !== undefined && out.length >= opts.stopAfter) break;
      }
      return out;
    },
    rows: () => usageRows(env, account.billingAccountId),
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

/**
 * `max` at $150 in, $600 out per million tokens. `request()`'s 'hi' is 5
 * estimated input tokens: a hold of 60_750 µ$ for 5 in, 100 out, and 750 µ$
 * for its input alone.
 */
const PRICED = {
  ...env,
  MODEL_PRICES: JSON.stringify({ max: { in: 150_000_000, out: 600_000_000, context: 200_000 } }),
} as AppEnv;
const tag: UsageTag = {
  purpose: 'reply',
  treeId: 'tree_1',
  branchId: 'branch_1',
  nodeId: 'node_1',
};

describe('usage meter', () => {
  it('settles the reported cost, the list price, inline (no subscription), with tokens, tag and generation id', async () => {
    const h = await harness();
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
      provider_id: 'openrouter',
      model: 'max',
      hold_micros: 20_000,
      markup_bps: 0,
      fee_bps: 0,
      cost_nanos: 1_234_000,
      charge_micros: 1234,
      input_tokens: 12,
      output_tokens: 34,
    });
    expect(row!.settled_at).not.toBeNull();
    await h.settleBackground();
    expect((await h.rows())[0]!.generation_id).toBe(gen);
  });

  it('settles at the list price with a membership too, whatever the service fee', async () => {
    const account = simpleAccount();
    await insertSubscription(env, account.userId!, 'active');
    const h = await harness(account);
    await h.run(
      [
        { type: 'delta', text: 'x' },
        { type: 'billing', generationId: uniq('gen'), costUsd: COST },
        { type: 'done', stopReason: 'stop' },
      ],
      {
        env: {
          ...env,
          SERVICE_FEE_BPS: '500',
          ANNUAL_FEE_ENABLED: 'true',
        },
      },
    );
    expect((await h.rows())[0]).toMatchObject({
      status: 'settled',
      markup_bps: 0,
      fee_bps: 0,
      charge_micros: 1234,
    });
  });

  it('holds while the stream is in flight', async () => {
    const h = await harness();
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
    for await (const _ of meteredRegistry(registryOf(provider), meter, onlyBuiltIn)
      .get('openrouter')!
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
      charge_micros: chargeMicros(costUsdToNanos(0.5), 0, 0),
    });
  });

  it.each(['not_sent', 'rejected'] as const)(
    'releases at 0 a call the upstream never ran (%s)',
    async (upstream) => {
      const h = await harness();
      const events = await h.run([
        { type: 'usage', usage: { inputTokens: 12 } },
        {
          type: 'error',
          error: { code: 'network', message: 'connect failed', retryable: true, upstream },
        },
      ]);
      expect(events.at(-1)?.type).toBe('error');
      expect((await h.rows())[0]).toMatchObject({
        status: 'settled',
        settle_reason: 'released',
        cost_nanos: 0,
        charge_micros: 0,
      });
    },
  );

  it('reconciles an aborted run via /api/v1/generation (404, then 200)', async () => {
    const h = await harness();
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
      fee_bps: 0,
      charge_micros: 2000,
      input_tokens: 100,
      output_tokens: 7,
    });
    const calls = await generationCalls(gen);
    expect(calls.count).toBe(2);
    expect(calls.authorizations.every((a) => a === 'Bearer sk-or-simple-test')).toBe(true);
  });

  it('charges credit the list price whatever OPENROUTER_FEE_BPS is, reconciled too', async () => {
    const h = await harness();
    const gen = uniq('gen-fee');
    await scriptGeneration(gen, [{ costUsd: 0.001 }]);
    const custom = { ...env, OPENROUTER_FEE_BPS: '800' } as AppEnv;
    await h.run(
      [
        { type: 'billing', generationId: gen },
        { type: 'error', error: { code: 'aborted', message: 'aborted', retryable: false } },
      ],
      { env: custom },
    );
    expect((await h.rows())[0]).toMatchObject({ status: 'pending', fee_bps: 0 });
    await h.settleBackground();
    expect((await h.rows())[0]).toMatchObject({
      status: 'settled',
      fee_bps: 0,
      charge_micros: 1000,
    });
  });

  it('leaves the row pending for the cron when the generation never shows up', async () => {
    const h = await harness();
    const gen = uniq('gen-missing');
    await h.run([
      { type: 'billing', generationId: gen },
      { type: 'error', error: { code: 'aborted', message: 'aborted', retryable: false } },
    ]);
    await h.settleBackground();
    expect((await h.rows())[0]).toMatchObject({ status: 'pending', generation_id: gen });
    expect((await generationCalls(gen)).count).toBe(4);
  });

  it('uses the key named by BUILT_IN_PROVIDER.apiKeySecret', async () => {
    const h = await harness();
    const gen = uniq('gen-key');
    await scriptGeneration(gen, [{ costUsd: 0.001 }]);
    const custom = {
      ...env,
      BUILT_IN_PROVIDER: JSON.stringify({
        id: 'openrouter',
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
    expect((await h.rows())[0]).toMatchObject({ status: 'settled', charge_micros: 1000 });
    expect((await generationCalls(gen)).authorizations).toEqual(['Bearer sk-or-custom']);
  });

  it('finishes when the consumer stops reading early', async () => {
    const h = await harness();
    await h.run(
      [
        { type: 'delta', text: 'a' },
        { type: 'delta', text: 'b' },
        { type: 'billing', costUsd: 1 },
        { type: 'done', stopReason: null },
      ],
      { stopAfter: 1, env: PRICED },
    );
    // Sent, but no id, cost or tokens when the consumer left: its estimated input, at the input price.
    expect((await h.rows())[0]).toMatchObject({
      status: 'settled',
      settle_reason: 'tokens',
      cost_nanos: 750_000,
      charge_micros: 750,
    });
  });

  it('stamps a call dispatched before it is sent, with the input estimate its hold was sized with', async () => {
    const h = await harness();
    let pendingSeen: UsageRow[] = [];
    const meter = createUsageMeter(env, h.account, (p) => h.deferred.push(p), FAST);
    const provider = scriptedProvider(
      [
        { type: 'delta', text: 'a' },
        { type: 'billing', costUsd: COST },
        { type: 'done', stopReason: 'stop' },
      ],
      async (i) => {
        if (i === 0) pendingSeen = await h.rows();
      },
    );
    for await (const _ of meteredRegistry(registryOf(provider), meter, onlyBuiltIn)
      .get('openrouter')!
      .stream(request()))
      void _;
    expect(pendingSeen).toHaveLength(1);
    expect(pendingSeen[0]).toMatchObject({ status: 'pending', held_input_tokens: 5 });
    expect(pendingSeen[0]!.dispatched_at).not.toBeNull();
  });

  it('sends nothing and releases the row when it cannot be stamped dispatched', async () => {
    const h = await harness();
    const provider = scriptedProvider([{ type: 'done', stopReason: null }]);
    const broken = envWithFailingDb(env, /SET dispatched_at/);
    const meter = createUsageMeter(broken, h.account, (p) => h.deferred.push(p), FAST);
    const events: ProviderEvent[] = [];
    for await (const e of meteredRegistry(registryOf(provider), meter, onlyBuiltIn)
      .get('openrouter')!
      .stream(request()))
      events.push(e);
    expect(events).toEqual([
      { type: 'error', error: expect.objectContaining({ code: 'server', upstream: 'not_sent' }) },
    ]);
    expect(provider.calls).toBe(0);
    expect((await h.rows())[0]).toMatchObject({
      status: 'settled',
      settle_reason: 'released',
      charge_micros: 0,
      dispatched_at: null,
    });
  });

  it('fails as an event (no upstream call) when the pending row cannot be written', async () => {
    const h = await harness();
    const provider = scriptedProvider([{ type: 'done', stopReason: null }]);
    const broken = envWithFailingDb(env, /INSERT INTO usage_events/);
    const meter = createUsageMeter(broken, h.account, (p) => h.deferred.push(p), FAST);
    const events: ProviderEvent[] = [];
    for await (const e of meteredRegistry(registryOf(provider), meter, onlyBuiltIn)
      .get('openrouter')!
      .stream(request()))
      events.push(e);
    expect(events).toEqual([
      { type: 'error', error: expect.objectContaining({ code: 'server', retryable: true }) },
    ]);
    expect(provider.calls).toBe(0);
    expect(await h.rows()).toEqual([]);
  });

  it('never throws into the stream when settling fails; the row stays pending', async () => {
    const h = await harness();
    // Every write after the dispatch stamp fails.
    const broken = envWithFailingDb(env, /^\s*UPDATE(?! usage_events SET dispatched_at)/);
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
      onlyBuiltIn,
    );
    expect(registry.list()).toEqual(inner.list());
    expect(registry.defaultProviderId()).toBe('openrouter');
    expect(registry.get('nope')).toBeUndefined();
    const wrapped = registry.get('openrouter')!;
    expect(registry.get('openrouter')).toBe(wrapped);
    expect([wrapped.id, wrapped.kind, wrapped.label, wrapped.defaultModel()]).toEqual([
      'openrouter',
      'fake',
      'Tangent',
      'max',
    ]);
    expect(wrapped.capabilities('max').maxOutputTokens).toBe(100);
    expect(await wrapped.countTokens!(request())).toBe(42);
  });

  it('wraps only the providers it is told to meter', async () => {
    const provider = scriptedProvider([{ type: 'done', stopReason: null }]);
    const registry = meteredRegistry(
      registryOf(provider),
      createUsageMeter(env, simpleAccount(), () => undefined),
      () => false,
    );
    expect(registry.get('openrouter')).toBe(provider);
  });

  it("records power mode's calls on the user's ledger (u_<userId>)", async () => {
    const account = powerAccount();
    const h = await harness(account);
    await h.run([
      { type: 'billing', costUsd: COST },
      { type: 'done', stopReason: 'stop' },
    ]);
    expect(account.billingAccountId).toBe(`u_${account.userId}`);
    expect(await h.rows()).toEqual([expect.objectContaining({ status: 'settled' })]);
  });
});

describe('usage meter holds on credit', () => {
  /** `max` at about o1-pro's list price: $150 in, $600 out per million tokens. */
  const pricey = {
    ...env,
    MODEL_PRICES: JSON.stringify({
      max: { in: 150_000_000, out: 600_000_000, context: 200_000 },
    }),
  } as AppEnv;
  const reply = [
    { type: 'billing', costUsd: COST },
    { type: 'done', stopReason: 'stop' },
  ] satisfies ProviderEvent[];

  it("holds a pricey model's call at its own worst case, not the flat hold", async () => {
    const h = await harness();
    let held: UsageRow[] = [];
    const meter = createUsageMeter(pricey, h.account, (p) => h.deferred.push(p), FAST);
    const provider = scriptedProvider(reply, async (i) => {
      if (i === 0) held = await h.rows();
    });
    for await (const _ of meteredRegistry(registryOf(provider), meter, onlyBuiltIn)
      .get('openrouter')!
      .stream(request()))
      void _;
    // 'hi' is 1 estimated token (chars / 3.5), + 4 for the message: 5 in, 100 out, at the list
    // price.
    const worst = chargeMicros(
      costFromTokensNanos(
        { inMicrosPerMTok: 150_000_000, outMicrosPerMTok: 600_000_000, contextTokens: 200_000 },
        5,
        100,
      ),
      0,
      0,
    );
    expect(worst).toBeGreaterThan(USAGE_HOLD_MICROS);
    expect(held).toEqual([expect.objectContaining({ status: 'pending', hold_micros: worst })]);
  });

  it('refuses the call, sending nothing, when the balance cannot cover its hold', async () => {
    const h = await harness();
    // Spend all but the flat hold: enough for a cheap model, not for this one.
    const { balanceMicros } = await getBalance(env.DB, h.account.billingAccountId);
    await grantCredit(env.DB, {
      accountId: h.account.billingAccountId,
      kind: 'adjustment',
      amountMicros: USAGE_HOLD_MICROS - balanceMicros,
      providerRef: null,
    });
    const provider = scriptedProvider(reply);
    const meter = createUsageMeter(pricey, h.account, (p) => h.deferred.push(p), FAST);
    const events: ProviderEvent[] = [];
    for await (const e of meteredRegistry(registryOf(provider), meter, onlyBuiltIn)
      .get('openrouter')!
      .stream(request()))
      events.push(e);
    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'payment_required',
          message: expect.stringMatching(
            /^This reply needs about \$0\.\d\d of Tangent credit available\./,
          ),
          retryable: false,
          upstream: 'not_sent',
        },
      },
    ]);
    expect(provider.calls).toBe(0);
    expect(await h.rows()).toEqual([]);
  });

  it('writes nothing for a user deleted since the call started, though their ledger has credit', async () => {
    const h = await harness();
    await env.DB.prepare('DELETE FROM auth_users WHERE id = ?').bind(h.account.userId).run();
    const provider = scriptedProvider(reply);
    const meter = createUsageMeter(env, h.account, (p) => h.deferred.push(p), FAST);
    const events: ProviderEvent[] = [];
    for await (const e of meteredRegistry(registryOf(provider), meter, onlyBuiltIn)
      .get('openrouter')!
      .stream(request()))
      events.push(e);
    expect(events).toMatchObject([{ type: 'error', error: { upstream: 'not_sent' } }]);
    expect(provider.calls).toBe(0);
    expect(await h.rows()).toEqual([]);
  });

  it('refuses a model without a known price: it could cost anything', async () => {
    const h = await harness();
    const unpriced = { ...env, MODEL_PRICES: '' } as AppEnv;
    const provider = scriptedProvider(reply);
    const meter = createUsageMeter(unpriced, h.account, (p) => h.deferred.push(p), FAST);
    const events: ProviderEvent[] = [];
    for await (const e of meteredRegistry(registryOf(provider), meter, onlyBuiltIn)
      .get('openrouter')!
      .stream(request()))
      events.push(e);
    expect(events).toMatchObject([
      {
        type: 'error',
        error: { code: 'config', message: expect.stringContaining('no known price') },
      },
    ]);
    expect(provider.calls).toBe(0);
    expect(await h.rows()).toEqual([]);
  });
});

describe('credit calls sent without a reported cost or generation id', () => {
  const priced = PRICED;
  const failedMidStream: ProviderEvent = {
    type: 'error',
    error: { code: 'network', message: 'lost', retryable: true, upstream: 'stream' },
  };

  it('charges the tokens it used at the list price, after an error mid-stream', async () => {
    const h = await harness();
    await h.run(
      [
        { type: 'delta', text: 'Hel' },
        { type: 'usage', usage: { inputTokens: 12, outputTokens: 34 } },
        failedMidStream,
      ],
      { env: priced },
    );
    // 12 × 150 + 34 × 600 = 22_200 µ$.
    expect((await h.rows())[0]).toMatchObject({
      status: 'settled',
      settle_reason: 'tokens',
      cost_nanos: 22_200_000,
      charge_micros: 22_200,
      input_tokens: 12,
      output_tokens: 34,
    });
  });

  it('charges the tokens of a call that finished without reporting its cost', async () => {
    const h = await harness();
    await h.run(
      [
        { type: 'delta', text: 'Hello' },
        { type: 'usage', usage: { inputTokens: 12, outputTokens: 34 } },
        { type: 'done', stopReason: 'stop' },
      ],
      { env: priced },
    );
    expect((await h.rows())[0]).toMatchObject({ settle_reason: 'tokens', charge_micros: 22_200 });
  });

  it.each<[string, ProviderEvent[]]>([
    ['no usage', [{ type: 'delta', text: 'Hel' }, failedMidStream]],
    ['the input alone', [{ type: 'usage', usage: { inputTokens: 12 } }, failedMidStream]],
    [
      'an error that says nothing of how far it got',
      [
        { type: 'usage', usage: { inputTokens: 12 } },
        { type: 'error', error: { code: 'unknown', message: '?', retryable: false } },
      ],
    ],
  ])('charges the hold when the tokens are unknown (%s)', async (_name, script) => {
    const h = await harness();
    await h.run(script, { env: priced });
    expect((await h.rows())[0]).toMatchObject({
      status: 'settled',
      settle_reason: 'hold',
      cost_nanos: null,
      hold_micros: 60_750,
      charge_micros: 60_750,
    });
  });
});

describe('credit calls the user stopped', () => {
  /** Runs `script` on PRICED, aborting the caller's signal before the event at `abortAt`. */
  async function stopped(script: ProviderEvent[], abortAt: number): Promise<UsageRow | undefined> {
    const h = await harness();
    const ac = new AbortController();
    const meter = createUsageMeter(PRICED, h.account, (p) => h.deferred.push(p), FAST);
    const provider = scriptedProvider(script, (i) => {
      if (i === abortAt) ac.abort();
      return Promise.resolve();
    });
    for await (const _ of meteredRegistry(registryOf(provider), meter, onlyBuiltIn)
      .get('openrouter')!
      .stream(request(undefined, ac.signal)))
      void _;
    await h.settleBackground();
    return (await h.rows())[0];
  }
  const aborted: ProviderEvent = {
    type: 'error',
    error: { code: 'aborted', message: 'Request aborted', retryable: false },
  };

  it('charges its estimated input at the input price when nothing was reported', async () => {
    expect(await stopped([{ type: 'delta', text: 'Hel' }, aborted], 1)).toMatchObject({
      status: 'settled',
      settle_reason: 'tokens',
      cost_nanos: 750_000,
      charge_micros: 750,
    });
  });

  it('charges the input it reported, at the input price, when the output is unknown', async () => {
    const row = await stopped([{ type: 'usage', usage: { inputTokens: 12 } }, aborted], 1);
    // 12 × 150 = 1_800 µ$.
    expect(row).toMatchObject({ settle_reason: 'tokens', charge_micros: 1_800 });
  });

  it('charges the tokens it reported, as any call', async () => {
    const row = await stopped(
      [{ type: 'usage', usage: { inputTokens: 12, outputTokens: 34 } }, aborted],
      1,
    );
    expect(row).toMatchObject({ settle_reason: 'tokens', charge_micros: 22_200 });
  });

  it('charges the hold for an abort the user did not ask for', async () => {
    const h = await harness();
    await h.run([{ type: 'delta', text: 'Hel' }, aborted], { env: PRICED });
    expect((await h.rows())[0]).toMatchObject({ settle_reason: 'hold', charge_micros: 60_750 });
  });
});

describe('reserved replies on credit', () => {
  const target = { treeId: 'tree_1', branchId: 'branch_1', providerId: 'openrouter', model: 'max' };
  const reply = [
    { type: 'billing', costUsd: COST },
    { type: 'done', stopReason: 'stop' },
  ] satisfies ProviderEvent[];

  /** Moves the account's available balance to `micros` with an adjustment. */
  async function setAvailable(accountId: string, micros: number): Promise<void> {
    const { balanceMicros, heldMicros } = await getBalance(env.DB, accountId);
    await grantCredit(env.DB, {
      accountId,
      kind: 'adjustment',
      amountMicros: micros - (balanceMicros - heldMicros),
      providerRef: null,
    });
  }

  it('lowers a reservation to the call, whatever the balance, and settles that row', async () => {
    const h = await harness();
    const id = await reserveCreditReply(env, h.account, target, 500_000);
    await setAvailable(h.account.billingAccountId, -1_000);
    expect(
      await repriceReservation(env.DB, id, h.account.billingAccountId, 400_000, 'n1', 7),
    ).toEqual({ feeBps: 0, markupBps: 0 });
    await h.run(reply, { tag: { ...tag, reservationId: id } });
    const rows = await h.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      hold_micros: USAGE_HOLD_MICROS,
      node_id: 'n1',
      status: 'settled',
      charge_micros: 1234,
      // The meter's own estimate of 'hi', recorded when it repriced the row.
      held_input_tokens: 5,
    });
    expect(rows[0]!.dispatched_at).not.toBeNull();
  });

  it('raises a reservation only while the rest of the available balance covers the increase', async () => {
    const h = await harness();
    const accountId = h.account.billingAccountId;
    const id = await reserveCreditReply(env, h.account, target, 1_000);
    await setAvailable(accountId, 4_000);
    expect(await repriceReservation(env.DB, id, accountId, 5_001, null, 7)).toBeNull();
    expect((await usageRow(env, id)).hold_micros).toBe(1_000);
    expect(await repriceReservation(env.DB, id, accountId, 5_000, null, 7)).not.toBeNull();
    expect((await usageRow(env, id)).hold_micros).toBe(5_000);
  });

  it("never reprices a dispatched row, another account's, or a settled one", async () => {
    const h = await harness();
    const accountId = h.account.billingAccountId;
    const dispatched = await reserveCreditReply(env, h.account, target, 1_000);
    expect(await markDispatched(env.DB, dispatched)).toBe(true);
    expect(await repriceReservation(env.DB, dispatched, accountId, 500, null, 7)).toBeNull();
    const other = await reserveCreditReply(env, h.account, target, 1_000);
    expect(await repriceReservation(env.DB, other, uniq('acct'), 500, null, 7)).toBeNull();
    expect((await usageRow(env, other)).hold_micros).toBe(1_000);
  });

  it('gives a call whose reservation is already used a fresh row (a retry without search)', async () => {
    const h = await harness();
    const id = await reserveCreditReply(env, h.account, target, 500_000);
    const reserved = { tag: { ...tag, reservationId: id } };
    await h.run(
      [
        {
          type: 'error',
          error: {
            code: 'invalid_request',
            message: 'no tools',
            status: 400,
            retryable: false,
            upstream: 'rejected',
          },
        },
      ],
      reserved,
    );
    await h.run(reply, reserved);
    await h.settleBackground();
    const rows = await h.rows();
    expect(rows).toHaveLength(2);
    const fresh = rows.find((r) => r.id !== id);
    expect(await usageRow(env, id)).toMatchObject({ status: 'settled', settle_reason: 'released' });
    expect(fresh).toMatchObject({
      status: 'settled',
      node_id: 'node_1',
      hold_micros: USAGE_HOLD_MICROS,
      charge_micros: 1234,
    });
  });
});

describe('usage meter web searches', () => {
  it('records the reported search count; the search fee is inside the reported cost', async () => {
    const h = await harness();
    await h.run(
      [
        { type: 'billing', generationId: uniq('gen-ws') },
        { type: 'activity', kind: 'web_search' },
        { type: 'delta', text: 'grounded' },
        {
          type: 'citations',
          citations: [{ url: 'https://example.org', title: null, excerpt: null }],
        },
        { type: 'billing', costUsd: 0.008, webSearches: 1 },
        { type: 'done', stopReason: 'stop' },
      ],
      { tag },
    );
    expect((await h.rows())[0]).toMatchObject({
      status: 'settled',
      web_searches: 1,
      cost_nanos: 8_000_000,
      charge_micros: 8000,
    });
  });

  it('counts one search when a search started but no count was reported', async () => {
    const h = await harness();
    await h.run(
      [
        { type: 'activity', kind: 'web_search' },
        { type: 'billing', costUsd: 0.008 },
        { type: 'done', stopReason: 'stop' },
      ],
      { tag },
    );
    expect((await h.rows())[0]!.web_searches).toBe(1);
  });

  it('records no search for a plain reply', async () => {
    const h = await harness();
    await h.run(
      [
        { type: 'billing', costUsd: COST },
        { type: 'done', stopReason: 'stop' },
      ],
      { tag },
    );
    expect((await h.rows())[0]!.web_searches).toBe(0);
  });

  it('an aborted grounded run settles from /generation, search results counting as a search', async () => {
    const h = await harness();
    const gen = uniq('gen-ws-aborted');
    await scriptGeneration(gen, [{ costUsd: 0.0075, numSearchResults: 5 }]);
    await h.run(
      [
        { type: 'billing', generationId: gen },
        { type: 'error', error: { code: 'aborted', message: 'aborted', retryable: false } },
      ],
      { tag },
    );
    await h.settleBackground();
    expect((await h.rows())[0]).toMatchObject({
      status: 'settled',
      cost_nanos: 7_500_000,
      web_searches: 1,
    });
  });
});

describe('the call log', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const lines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls
      .map(([line]) =>
        typeof line === 'string' ? (JSON.parse(line) as Record<string, unknown>) : null,
      )
      .filter((l) => l?.['event'] === 'llm_call');

  it('logs each call once: tier, served provider, cached and reasoning tokens, cost, finish reason', async () => {
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const h = await harness();
    await h.run(
      [
        { type: 'billing', generationId: uniq('gen') },
        { type: 'billing', servedBy: 'DeepSeek' },
        { type: 'delta', text: 'Hello' },
        {
          type: 'usage',
          usage: { inputTokens: 120, cacheReadTokens: 100, outputTokens: 40, reasoningTokens: 30 },
        },
        { type: 'billing', costUsd: COST },
        { type: 'done', stopReason: 'stop' },
      ],
      { tag },
    );
    const [row] = await h.rows();
    expect(lines(warn)).toEqual([]);
    expect(lines(log)).toEqual([
      {
        event: 'llm_call',
        usageId: row!.id,
        funding: 'credit',
        purpose: 'reply',
        providerId: 'openrouter',
        model: 'max',
        tier: 'max',
        effort: null,
        providerOrder: null,
        servedBy: 'DeepSeek',
        maxOutputTokens: 100,
        inputTokens: 120,
        cacheReadTokens: 100,
        cacheWriteTokens: null,
        outputTokens: 40,
        reasoningTokens: 30,
        costUsd: COST,
        finishReason: 'stop',
        truncated: false,
        error: null,
      },
    ]);
    // The charge is the reported cost, whatever the cap was.
    expect(row).toMatchObject({ status: 'settled', cost_nanos: 1_234_000 });
  });

  it('warns about a reply cut off at its cap', async () => {
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const h = await harness();
    await h.run(
      [
        { type: 'delta', text: 'Half an' },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 100, reasoningTokens: 95 } },
        { type: 'billing', generationId: uniq('gen'), costUsd: COST },
        { type: 'done', stopReason: 'length' },
      ],
      { tag },
    );
    expect(lines(log)).toEqual([]);
    expect(lines(warn)).toMatchObject([
      { finishReason: 'length', truncated: true, reasoningTokens: 95, tier: 'max' },
    ]);
  });

  it('logs nothing for a call never sent upstream', async () => {
    const log = vi.spyOn(console, 'log');
    const h = await harness();
    await h.run([{ type: 'done', stopReason: 'stop' }], {
      env: envWithFailingDb(env, /INSERT INTO usage_events/),
    });
    expect(lines(log)).toEqual([]);
  });
});
