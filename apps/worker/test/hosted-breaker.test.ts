import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPENROUTER_PROVIDER_ID, type ProviderError } from '@tangent/shared';
import type { AppEnv } from '../src/env.js';
import {
  breakerClock,
  breakerOpen,
  breakerWindowMs,
  resetBreakers,
  tripBreaker,
} from '../src/hosted/breaker.js';
import { hostedLegs } from '../src/hosted/legs.js';
import { registryFor } from '../src/registries.js';
import { simpleAccount } from './mocks/billing-helpers.js';

const HAIKU = 'anthropic/claude-haiku-5.5';
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

/** Sets the breaker's clock to `ms`. */
function at(ms: number): void {
  vi.spyOn(breakerClock, 'now').mockReturnValue(ms);
}

function chain(): string[] {
  const outer = registryFor(both, simpleAccount()).get(OPENROUTER_PROVIDER_ID)!;
  return hostedLegs(both)(outer, HAIKU).map((l) => l.backend.id);
}

afterEach(() => {
  resetBreakers();
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
    at(1_000_000);
    tripBreaker('anthropic', error({ code: 'overloaded', status: 529, retryAfterMs: 90 * SEC }));
    expect(breakerOpen('anthropic')).toBe(true);
    expect(breakerOpen('openrouter')).toBe(false);
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toEqual([
      {
        event: 'backend_circuit_open',
        backend: 'anthropic',
        untilMs: 1_000_000 + 90 * SEC,
        reason: 'overloaded',
      },
    ]);
    at(1_000_000 + 90 * SEC - 1);
    expect(breakerOpen('anthropic')).toBe(true);
    at(1_000_000 + 90 * SEC);
    expect(breakerOpen('anthropic')).toBe(false);
  });

  it('never shortens a window already open, and ignores errors about the call', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    at(0);
    tripBreaker('anthropic', error({ retryAfterMs: 4 * MIN }));
    tripBreaker('anthropic', error({}));
    tripBreaker('openrouter', error({ code: 'invalid_request', status: 400 }));
    at(3 * MIN);
    expect(breakerOpen('anthropic')).toBe(true);
    expect(breakerOpen('openrouter')).toBe(false);
  });

  it('leaves an open backend out of the chain, and keeps the chain whole when all are open', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    at(0);
    expect(chain()).toEqual(['anthropic', 'openrouter']);
    tripBreaker('anthropic', error({}));
    expect(chain()).toEqual(['openrouter']);
    tripBreaker('openrouter', error({ code: 'server', status: 502 }));
    expect(chain()).toEqual(['anthropic', 'openrouter']);
    // Both windows pass: Anthropic is the first choice again.
    at(30 * SEC);
    expect(chain()).toEqual(['anthropic', 'openrouter']);
    expect(breakerOpen('anthropic')).toBe(false);
  });
});
