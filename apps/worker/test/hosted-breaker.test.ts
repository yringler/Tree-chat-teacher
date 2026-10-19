import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPENROUTER_PROVIDER_ID,
  type GenerateRequest,
  type ProviderError,
  type ProviderEvent,
} from '@tangent/shared';
import type { AppEnv } from '../src/env.js';
import { breakerOpen, breakerWindowMs, tripBreaker } from '../src/hosted/breaker.js';
import { grantCredit } from '../src/billing/ledger.js';
import { meteredRegistry } from '../src/billing/meter.js';
import { createUsageMeter } from '../src/billing/personal-meter.js';
import { hostedLegs } from '../src/hosted/legs.js';
import { registryFor } from '../src/registries.js';
import { ensureUser, simpleAccount, uniq, usageRows } from './mocks/billing-helpers.js';

const HAIKU = 'anthropic/claude-haiku-5.5';
const SONNET = 'anthropic/claude-sonnet-5.5';
/** The models' ids on Anthropic, which keys its breakers. */
const HAIKU_ANT = 'claude-haiku-5-5';
const SONNET_ANT = 'claude-sonnet-5-5';
const SEC = 1_000;
const MIN = 60 * SEC;

/** Anthropic first, then OpenRouter, both with their keys. */
const both = {
  ...(rawEnv as unknown as AppEnv),
  BUILT_IN_PROVIDER: '',
  BUILT_IN_API_KEY: 'sk-or-operator',
  BUILT_IN_BACKENDS: 'anthropic,openrouter',
  BUILT_IN_ANTHROPIC_API_KEY: 'sk-ant-operator',
} as AppEnv;

function error(overrides: Partial<ProviderError>): ProviderError {
  return {
    code: 'rate_limit',
    message: 'slow down',
    retryable: true,
    status: 429,
    upstream: 'rejected',
    ...overrides,
  };
}

/** The time the chains and the meter read (`Date.now()`), from the test's start. */
const start = Date.now();

/** Sets the clock the chains and the meter read to `ms` after the test's start. */
function at(ms: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(start + ms);
}

/** The backends `logical`'s chain tries now, first choice first. */
function chain(logical = HAIKU): string[] {
  const outer = registryFor(both, simpleAccount()).get(OPENROUTER_PROVIDER_ID)!;
  return hostedLegs(both)(outer, logical).map((l) => l.backend.id);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the breaker window of an error', () => {
  it('is the retry-after of a rate limit or an overload, within 30 s and 5 min', () => {
    expect(breakerWindowMs(error({}))).toBe(30 * SEC);
    expect(breakerWindowMs(error({ retryAfterMs: 2 * SEC }))).toBe(30 * SEC);
    expect(
      breakerWindowMs(error({ code: 'overloaded', status: 529, retryAfterMs: 90 * SEC })),
    ).toBe(90 * SEC);
    expect(breakerWindowMs(error({ retryAfterMs: 60 * MIN }))).toBe(5 * MIN);
    // An overload Anthropic reports mid-stream says the same about the backend.
    expect(breakerWindowMs(error({ code: 'overloaded', upstream: 'stream' }))).toBe(30 * SEC);
  });

  it('is 30 s for a server error or a failed connection the upstream refused or never got', () => {
    expect(breakerWindowMs(error({ code: 'server', status: 500, retryAfterMs: 4 * MIN }))).toBe(
      30 * SEC,
    );
    expect(breakerWindowMs(error({ code: 'network', upstream: 'not_sent' }))).toBe(30 * SEC);
    // Cut off mid-stream: maybe the connection, not the backend.
    expect(breakerWindowMs(error({ code: 'network', upstream: 'stream' }))).toBeNull();
  });

  it('is none for an error about the call itself', () => {
    for (const code of ['invalid_request', 'context_length', 'auth', 'config', 'aborted'] as const)
      expect(breakerWindowMs(error({ code, status: 400 }))).toBeNull();
  });
});

describe('the breaker', () => {
  it('opens for the window, logs it, and closes when it passes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const now = 1_000_000;
    const overloaded = error({ code: 'overloaded', status: 529, retryAfterMs: 90 * SEC });
    tripBreaker('anthropic', HAIKU_ANT, overloaded, now);
    expect(breakerOpen('anthropic', HAIKU_ANT, now)).toBe(true);
    expect(breakerOpen('openrouter', HAIKU, now)).toBe(false);
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toEqual([
      {
        event: 'backend_circuit_open',
        backend: 'anthropic',
        model: HAIKU_ANT,
        untilMs: now + 90 * SEC,
        reason: 'overloaded',
      },
    ]);
    expect(breakerOpen('anthropic', HAIKU_ANT, now + 90 * SEC - 1)).toBe(true);
    expect(breakerOpen('anthropic', HAIKU_ANT, now + 90 * SEC)).toBe(false);
  });

  it('never shortens a window already open, and ignores errors about the call', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    tripBreaker('anthropic', HAIKU_ANT, error({ retryAfterMs: 4 * MIN }), 0);
    tripBreaker('anthropic', HAIKU_ANT, error({}), 0);
    tripBreaker('openrouter', HAIKU, error({ code: 'invalid_request', status: 400 }), 0);
    expect(breakerOpen('anthropic', HAIKU_ANT, 3 * MIN)).toBe(true);
    expect(breakerOpen('openrouter', HAIKU, 3 * MIN)).toBe(false);
  });

  it('moves an open backend to the end of the chain, keeping every leg as a fallback', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    at(0);
    expect(chain()).toEqual(['anthropic', 'openrouter']);
    // OpenRouter failing leaves the order as it is: it stays the fallback behind Anthropic.
    tripBreaker('openrouter', HAIKU, error({ code: 'server', status: 502 }), Date.now());
    expect(chain()).toEqual(['anthropic', 'openrouter']);
    tripBreaker('anthropic', HAIKU_ANT, error({}), Date.now());
    expect(chain()).toEqual(['anthropic', 'openrouter']);
    // OpenRouter's window passes first: it leads, Anthropic still behind it.
    at(10 * SEC);
    tripBreaker('anthropic', HAIKU_ANT, error({ retryAfterMs: 60 * SEC }), Date.now());
    at(30 * SEC);
    expect(chain()).toEqual(['openrouter', 'anthropic']);
    // Both windows pass: Anthropic is the first choice again.
    at(70 * SEC);
    expect(chain()).toEqual(['anthropic', 'openrouter']);
  });

  it("is per model: a rate limit on one model leaves the backend's other models where they are", () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    at(0);
    tripBreaker('anthropic', SONNET_ANT, error({ retryAfterMs: 60 * SEC }), Date.now());
    expect(chain(SONNET)).toEqual(['openrouter', 'anthropic']);
    expect(chain(HAIKU)).toEqual(['anthropic', 'openrouter']);
    expect(breakerOpen('anthropic', HAIKU_ANT, Date.now())).toBe(false);
  });
});

/** OpenRouter's stream of a short reply that reports its cost. */
function openRouterReply(): Response {
  const chunks = [
    { choices: [{ delta: { content: 'Hi' } }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
    },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** Anthropic answers 529 with `retry-after: 90`; OpenRouter answers. Returns each request's origin. */
function overloadedAnthropic(): string[] {
  const origins: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const origin = new URL(new Request(input, init).url).origin;
    origins.push(origin);
    if (origin === 'https://api.anthropic.com') {
      const body = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 529, headers: { 'retry-after': '90' } }),
      );
    }
    return Promise.resolve(openRouterReply());
  });
  return origins;
}

function haikuRequest(): GenerateRequest {
  return {
    model: HAIKU,
    system: null,
    messages: [{ role: 'user', content: 'hi' }],
    maxOutputTokens: 100,
    signal: new AbortController().signal,
    usageTag: { purpose: 'reply', treeId: 'tree_1', branchId: 'branch_1', nodeId: uniq('n') },
  };
}

describe('a call whose first backend is overloaded', () => {
  it('runs on the next, keeps later calls off the first for its retry-after, then returns to it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const origins = overloadedAnthropic();
    const account = simpleAccount();
    await ensureUser(both, account.userId!);
    await grantCredit(both.DB, {
      accountId: account.billingAccountId,
      kind: 'adjustment',
      amountMicros: 5_000_000,
      providerRef: `test-funds:${account.billingAccountId}`,
    });
    const registry = meteredRegistry(
      registryFor(both, account),
      createUsageMeter(both, account, () => undefined),
      () => true,
      hostedLegs(both),
    );
    const call = async (): Promise<ProviderEvent[]> => {
      const events: ProviderEvent[] = [];
      for await (const e of registry.get(OPENROUTER_PROVIDER_ID)!.stream(haikuRequest()))
        events.push(e);
      return events;
    };

    at(0);
    expect((await call()).at(-1)).toMatchObject({ type: 'done' });
    expect(origins).toEqual(['https://api.anthropic.com', 'https://openrouter.ai']);
    const lines = warn.mock.calls.map(([l]) => JSON.parse(String(l)) as Record<string, unknown>);
    expect(lines.find((l) => l['event'] === 'backend_circuit_open')).toEqual({
      event: 'backend_circuit_open',
      backend: 'anthropic',
      model: HAIKU_ANT,
      untilMs: start + 90 * SEC,
      reason: 'overloaded',
    });
    expect(lines.find((l) => l['event'] === 'backend_fallback')).toMatchObject({
      from: 'anthropic',
      to: 'openrouter',
      code: 'overloaded',
      status: 529,
      retryAfterMs: 90 * SEC,
    });

    // While it is open, the next call starts on OpenRouter.
    origins.length = 0;
    at(89 * SEC);
    expect((await call()).at(-1)).toMatchObject({ type: 'done' });
    expect(origins).toEqual(['https://openrouter.ai']);

    // Once it expires, Anthropic is tried first again.
    origins.length = 0;
    at(90 * SEC);
    await call();
    expect(origins[0]).toBe('https://api.anthropic.com');

    const rows = await usageRows(both, account.billingAccountId);
    expect(rows.map((r) => [r.backend, r.status, r.charge_micros])).toEqual([
      ['openrouter', 'settled', 1000],
      ['openrouter', 'settled', 1000],
      ['openrouter', 'settled', 1000],
    ]);
  });

  it("never sends a learner's own-key call anywhere else, nor lets it open the breaker", async () => {
    const origins: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      origins.push(new URL(new Request(input, init).url).origin);
      return Promise.resolve(new Response('{"error":{"message":"busy"}}', { status: 429 }));
    });
    const account = { ...simpleAccount(), payer: 'own-key' as const };
    const own = registryFor(both, account, { [OPENROUTER_PROVIDER_ID]: 'sk-or-learner' });
    const events: ProviderEvent[] = [];
    for await (const e of own.get(OPENROUTER_PROVIDER_ID)!.stream(haikuRequest())) events.push(e);
    expect(events).toMatchObject([{ type: 'error', error: { code: 'rate_limit' } }]);
    expect(origins).toEqual(['https://openrouter.ai']);
    expect(breakerOpen('openrouter', HAIKU, Date.now())).toBe(false);
    expect(breakerOpen('anthropic', HAIKU_ANT, Date.now())).toBe(false);
  });
});
