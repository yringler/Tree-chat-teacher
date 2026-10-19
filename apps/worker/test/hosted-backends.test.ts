import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { OPENROUTER_PROVIDER_ID } from '@tangent/shared';
import type { AppEnv } from '../src/env.js';
import { openRouterBackend } from '../src/hosted/openrouter.js';
import { backendsFor, hostedBackend } from '../src/hosted/registry.js';
import { poolFeeBps } from '../src/pool/params.js';
import { simpleProviderConfig } from '../src/simple-mode.js';
import { scriptGeneration, uniq } from './mocks/billing-helpers.js';

const env = { ...(rawEnv as unknown as AppEnv), BUILT_IN_PROVIDER: '' } as AppEnv;

describe('the OpenRouter backend', () => {
  it('serves every logical model under its own id', () => {
    expect(openRouterBackend.modelId('anthropic/claude-haiku-5.5')).toBe(
      'anthropic/claude-haiku-5.5',
    );
    expect(openRouterBackend.modelId('deepseek/deepseek-v4.1-flash')).toBe(
      'deepseek/deepseek-v4.1-flash',
    );
    expect(openRouterBackend.modelId('some-lab/new-model')).toBe('some-lab/new-model');
  });

  it('reports costs, looks generations up and bills no search outside the reported cost', () => {
    expect(openRouterBackend.cost).toBe('reported');
    expect(openRouterBackend.lookup).toBe(true);
    expect(openRouterBackend.searchFeeMicros).toBe(0);
  });

  it('charges the pool OpenRouter’s credit-purchase fee', () => {
    expect(openRouterBackend.feeBps({ ...env, OPENROUTER_FEE_BPS: '550' } as AppEnv)).toBe(550);
    expect(poolFeeBps({ ...env, OPENROUTER_FEE_BPS: '550' } as AppEnv, 'any/model')).toBe(550);
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

describe('the backend registry', () => {
  it('runs every built-in call on OpenRouter', () => {
    expect(hostedBackend('openrouter')).toBe(openRouterBackend);
    expect(backendsFor(env, 'anthropic/claude-haiku-5.5')).toEqual([openRouterBackend]);
  });
});
