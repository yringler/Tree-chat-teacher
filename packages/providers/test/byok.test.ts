import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@tangent/shared';
import { createAnthropicProvider } from '../src/anthropic.js';
import { createOpenAiCompatibleProvider } from '../src/openai-compatible.js';
import { DEFAULT_PROVIDER_CONFIGS, createProviderRegistry } from '../src/registry.js';
import { verifyApiKey } from '../src/verify.js';
import { collect, jsonResponse, mockFetch } from './helpers.js';

const ANTHROPIC: ProviderConfig = {
  id: 'anthropic',
  kind: 'anthropic',
  label: 'Anthropic',
  apiKeySecret: 'ANTHROPIC_API_KEY',
  defaultModel: 'claude-opus-5-5',
  models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }],
};
const OPENAI: ProviderConfig = {
  id: 'openai',
  kind: 'openai-compatible',
  label: 'OpenAI',
  apiKeySecret: 'OPENAI_API_KEY',
  defaultModel: 'gpt-5',
  models: [{ id: 'gpt-5', label: 'GPT-5' }],
};

const USER_KEY = 'sk-ant-api03-USERUSERUSERUSER';
const SERVER_KEY = 'sk-ant-api03-SERVERSERVERSERVER';

const request = () => ({
  model: 'claude-opus-5-5',
  system: null,
  messages: [{ role: 'user' as const, content: 'Hi' }],
  signal: new AbortController().signal,
});

describe('bring-your-own-key', () => {
  it('registry: a user key makes a provider available and is reported as the key source', () => {
    const none = createProviderRegistry(DEFAULT_PROVIDER_CONFIGS, { secrets: {} });
    expect(none.list().find((p) => p.id === 'anthropic')).toMatchObject({
      available: false,
      acceptsUserKey: true,
      keySource: null,
    });
    const server = createProviderRegistry(DEFAULT_PROVIDER_CONFIGS, {
      secrets: { ANTHROPIC_API_KEY: SERVER_KEY },
    });
    expect(server.list().find((p) => p.id === 'anthropic')).toMatchObject({
      available: true,
      keySource: 'server',
    });
    const user = createProviderRegistry(DEFAULT_PROVIDER_CONFIGS, {
      secrets: { ANTHROPIC_API_KEY: SERVER_KEY },
      apiKeys: { anthropic: USER_KEY },
    });
    expect(user.list().find((p) => p.id === 'anthropic')).toMatchObject({
      available: true,
      keySource: 'user',
    });
    expect(user.list().find((p) => p.id === 'fake')).toMatchObject({
      acceptsUserKey: false,
      keySource: null,
    });
    expect(JSON.stringify(user.list())).not.toContain(USER_KEY);
  });

  it('anthropic: the user key wins over the server secret', async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse(401, { error: { type: 'authentication_error', message: 'bad' } }),
    );
    const p = createAnthropicProvider(ANTHROPIC, {
      secrets: { ANTHROPIC_API_KEY: SERVER_KEY },
      apiKeys: { anthropic: USER_KEY },
      fetch,
    });
    await collect(p.stream(request()));
    expect(calls[0]!.headers['x-api-key']).toBe(USER_KEY);
  });

  it('anthropic: a user key works without any configured secret, and is redacted from errors', async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse(400, {
        error: { type: 'invalid_request_error', message: `bad key ${USER_KEY}` },
      }),
    );
    const p = createAnthropicProvider(
      { ...ANTHROPIC, apiKeySecret: undefined },
      { secrets: {}, apiKeys: { anthropic: USER_KEY }, fetch },
    );
    const events = await collect(p.stream(request()));
    expect(calls[0]!.headers['x-api-key']).toBe(USER_KEY);
    expect(JSON.stringify(events)).not.toContain(USER_KEY);
  });

  it('openai-compatible: the user key goes into the bearer header', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(401, { error: { message: 'no' } }));
    const p = createOpenAiCompatibleProvider(OPENAI, {
      secrets: {},
      apiKeys: { openai: 'sk-proj-USERKEY1234567890' },
      fetch,
    });
    await collect(p.stream({ ...request(), model: 'gpt-5' }));
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-proj-USERKEY1234567890');
  });

  it('a key for another provider id is not used', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(401, {}));
    const p = createAnthropicProvider(ANTHROPIC, {
      secrets: {},
      apiKeys: { openai: USER_KEY },
      fetch,
    });
    const events = await collect(p.stream(request()));
    expect(calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'config' } });
  });

  describe('verifyApiKey', () => {
    it('anthropic: GET /v1/models with x-api-key; 200 → valid, 401 → rejected, 500 → unverified', async () => {
      for (const [status, expected] of [
        [200, 'valid'],
        [401, 'rejected'],
        [403, 'rejected'],
        [500, 'unverified'],
      ] as const) {
        const { fetch, calls } = mockFetch(() => jsonResponse(status, {}));
        expect(await verifyApiKey(ANTHROPIC, USER_KEY, { secrets: {}, fetch })).toBe(expected);
        expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models?limit=1');
        expect(calls[0]!.init.method).toBe('GET');
        expect(calls[0]!.headers['x-api-key']).toBe(USER_KEY);
      }
    });

    it('openai-compatible: GET {baseUrl}/models with bearer auth', async () => {
      const { fetch, calls } = mockFetch(() => jsonResponse(200, { data: [] }));
      const cfg = { ...OPENAI, baseUrl: 'https://llm.example.com/v1/' };
      expect(await verifyApiKey(cfg, 'sk-abc', { secrets: {}, fetch })).toBe('valid');
      expect(calls[0]!.url).toBe('https://llm.example.com/v1/models');
      expect(calls[0]!.headers['authorization']).toBe('Bearer sk-abc');
    });

    it('network failure → unverified', async () => {
      const fetch = (() => Promise.reject(new TypeError('offline'))) as typeof globalThis.fetch;
      expect(await verifyApiKey(ANTHROPIC, USER_KEY, { secrets: {}, fetch })).toBe('unverified');
    });
  });
});
