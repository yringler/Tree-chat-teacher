import { describe, expect, it } from 'vitest';
import { isProviderAvailable, type ProviderConfig } from '@tangent/shared';
import {
  DEFAULT_PROVIDER_CONFIGS,
  PROVIDER_FACTORIES,
  createProviderRegistry,
  parseProviderConfigs,
} from '../src/registry.js';
import { collect } from './helpers.js';

const signal = () => new AbortController().signal;

/** The test provider: a test seam, configured explicitly, never a default. */
const FAKE: ProviderConfig = {
  id: 'fake',
  kind: 'fake',
  label: 'Fake',
  defaultModel: 'fake-1',
  models: [{ id: 'fake-1', label: 'Fake 1' }],
};

describe('provider registry', () => {
  it('registers all kinds', () => {
    expect(Object.keys(PROVIDER_FACTORIES).sort()).toEqual([
      'anthropic',
      'fake',
      'openai-compatible',
    ]);
  });

  it('has the documented defaults, which round-trip through the parser', () => {
    expect(
      DEFAULT_PROVIDER_CONFIGS.map((c) => [c.id, c.kind, c.apiKeySecret, c.defaultModel]),
    ).toEqual([
      ['anthropic', 'anthropic', 'ANTHROPIC_API_KEY', 'claude-opus-5-5'],
      ['openai', 'openai-compatible', 'OPENAI_API_KEY', 'gpt-5'],
      ['openrouter', 'openai-compatible', 'OPENROUTER_API_KEY', 'anthropic/claude-sonnet-5.5'],
    ]);
    expect(parseProviderConfigs(JSON.stringify(DEFAULT_PROVIDER_CONFIGS))).toEqual(
      DEFAULT_PROVIDER_CONFIGS,
    );
  });

  it('with no secrets: none of the defaults is available; the first is the default', async () => {
    const reg = createProviderRegistry(DEFAULT_PROVIDER_CONFIGS, { secrets: {} });
    expect(reg.list().map((p) => [p.id, p.available])).toEqual([
      ['anthropic', false],
      ['openai', false],
      ['openrouter', false],
    ]);
    expect(reg.defaultProviderId()).toBe('anthropic');
    const anthropic = reg.get('anthropic')!;
    expect(anthropic.models().length).toBe(4);
    expect(
      await collect(
        anthropic.stream({
          model: 'claude-opus-5-5',
          system: null,
          messages: [],
          signal: signal(),
        }),
      ),
    ).toEqual([
      {
        type: 'error',
        error: { code: 'config', message: 'Missing secret ANTHROPIC_API_KEY', retryable: false },
      },
    ]);
    await expect(
      anthropic.countTokens!({ model: 'claude-opus-5-5', system: null, messages: [] }),
    ).rejects.toMatchObject({ error: { code: 'config' } });
    expect(reg.get('nope')).toBeUndefined();
  });

  it('defaults to the first available non-fake provider', () => {
    const reg = createProviderRegistry([FAKE, ...DEFAULT_PROVIDER_CONFIGS], {
      secrets: { OPENROUTER_API_KEY: 'k', ANTHROPIC_API_KEY: '' },
    });
    expect(reg.list().find((p) => p.id === 'openrouter')?.available).toBe(true);
    expect(reg.list().find((p) => p.id === 'anthropic')?.available).toBe(false);
    expect(reg.defaultProviderId()).toBe('openrouter');
    // `get` returns the keyless one too (its calls explain the missing key).
    expect(reg.get('anthropic')).toBeDefined();
    expect(isProviderAvailable(reg, 'anthropic')).toBe(false);
    expect(isProviderAvailable(reg, 'openrouter')).toBe(true);
    expect(isProviderAvailable(reg, 'fake')).toBe(true);
    expect(isProviderAvailable(reg, 'nope')).toBe(false);
    // With nothing else available, a configured test provider is the default.
    expect(
      createProviderRegistry([...DEFAULT_PROVIDER_CONFIGS, FAKE], {
        secrets: {},
      }).defaultProviderId(),
    ).toBe('fake');
  });

  it('falls back to the first configured provider when nothing is available', () => {
    const reg = createProviderRegistry(DEFAULT_PROVIDER_CONFIGS.slice(0, 2), { secrets: {} });
    expect(reg.defaultProviderId()).toBe('anthropic');
  });

  it('treats a keyless openai-compatible provider with explicit baseUrl as available (local server)', () => {
    const configs: ProviderConfig[] = [
      {
        id: 'local',
        kind: 'openai-compatible',
        label: 'Local',
        baseUrl: 'http://localhost:8080/v1',
        defaultModel: 'm',
        models: [],
      },
      { id: 'nokey', kind: 'openai-compatible', label: 'No key', defaultModel: 'm', models: [] },
      { id: 'anth', kind: 'anthropic', label: 'A', defaultModel: 'm', models: [] },
    ];
    const reg = createProviderRegistry(configs, { secrets: {} });
    expect(reg.list().map((p) => p.available)).toEqual([true, false, false]);
    expect(reg.defaultProviderId()).toBe('local');
  });

  it('requires extra header secrets for availability', async () => {
    const configs: ProviderConfig[] = [
      {
        id: 'gw',
        kind: 'anthropic',
        label: 'Gateway',
        baseUrl: 'https://gateway.ai.cloudflare.com/v1/a/g/anthropic',
        apiKeySecret: 'ANTHROPIC_API_KEY',
        extraHeaderSecrets: { 'cf-aig-authorization': 'CF_AIG_TOKEN' },
        defaultModel: 'claude-opus-5-5',
        models: [],
      },
    ];
    const reg = createProviderRegistry(configs, { secrets: { ANTHROPIC_API_KEY: 'k' } });
    expect(reg.list()[0]!.available).toBe(false);
    const events = await collect(
      reg.get('gw')!.stream({ model: 'x', system: null, messages: [], signal: signal() }),
    );
    expect(events).toEqual([
      {
        type: 'error',
        error: { code: 'config', message: 'Missing secret CF_AIG_TOKEN', retryable: false },
      },
    ]);
  });

  it('list() exposes no secrets or URLs', () => {
    const reg = createProviderRegistry(DEFAULT_PROVIDER_CONFIGS, {
      secrets: { OPENROUTER_API_KEY: 'secret-value' },
    });
    const json = JSON.stringify(reg.list());
    expect(json).not.toContain('secret-value');
    expect(json).not.toContain('OPENROUTER_API_KEY');
    expect(json).not.toContain('https://');
    expect(Object.keys(reg.list()[0]!).sort()).toEqual([
      'acceptsUserKey',
      'available',
      'defaultModel',
      'id',
      'keySource',
      'kind',
      'label',
      'models',
      'openModels',
      'webSearch',
    ]);
    expect(reg.list().map((p) => [p.id, p.webSearch])).toEqual([
      ['anthropic', true],
      ['openai', false],
      ['openrouter', true],
    ]);
  });

  it('streams through an available fake provider', async () => {
    const reg = createProviderRegistry([FAKE], { secrets: {} });
    const events = await collect(
      reg.get('fake')!.stream({
        model: 'fake-1',
        system: null,
        messages: [{ role: 'user', content: 'hi' }],
        signal: signal(),
      }),
    );
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  describe('parseProviderConfigs', () => {
    const valid = {
      id: 'x',
      kind: 'openai-compatible',
      label: 'X',
      baseUrl: 'https://example.com/v1',
      apiKeySecret: 'X_KEY',
      headers: { 'x-a': 'b' },
      extraHeaderSecrets: { 'cf-aig-authorization': 'CF' },
      models: [{ id: 'm1', label: 'M1', maxContextTokens: 1000 }],
      defaultModel: 'm1',
      maxOutputTokens: 100,
      supportsSystemPrompt: false,
      options: { maxTokensParam: 'max_tokens' },
    };

    it('accepts a full valid config', () => {
      expect(parseProviderConfigs(JSON.stringify([valid]))).toEqual([valid]);
    });

    it('accepts options.extraBody and fake costUsd', () => {
      const withExtra = { ...valid, options: { extraBody: { reasoning: { effort: 'low' } } } };
      const fake = {
        id: 'f',
        kind: 'fake',
        label: 'F',
        models: [{ id: 'f1', label: 'F1' }],
        defaultModel: 'f1',
        options: { costUsd: 0.001 },
      };
      expect(parseProviderConfigs(JSON.stringify([withExtra, fake]))).toEqual([withExtra, fake]);
    });

    it('accepts a model reasoning flag, and rejects a non-boolean one', () => {
      const flagged = { ...valid, models: [{ id: 'm1', label: 'M1', reasoning: true }] };
      expect(parseProviderConfigs(JSON.stringify([flagged]))).toEqual([flagged]);
      expect(() =>
        parseProviderConfigs(
          JSON.stringify([{ ...valid, models: [{ id: 'm1', label: 'M1', reasoning: 'yes' }] }]),
        ),
      ).toThrow(/reasoning must be a boolean/);
    });

    it('accepts a model effort and provider order; rejects max and malformed ones', () => {
      const tuned = {
        ...valid,
        models: [{ id: 'm1', label: 'M1', effort: 'low', providerOrder: ['deepseek'] }],
      };
      expect(parseProviderConfigs(JSON.stringify([tuned]))).toEqual([tuned]);
      const parse = (model: Record<string, unknown>) => () =>
        parseProviderConfigs(
          JSON.stringify([{ ...valid, models: [{ id: 'm1', label: 'M1', ...model }] }]),
        );
      expect(parse({ effort: 'max' })).toThrow(/effort must be one of "none", "low", "high"/);
      expect(parse({ effort: 'medium' })).toThrow(/effort must be one of/);
      expect(parse({ providerOrder: 'deepseek' })).toThrow(/providerOrder must be an array/);
      expect(parse({ providerOrder: [''] })).toThrow(/providerOrder must be an array/);
    });

    it('never lists a model effort or provider order to clients', () => {
      const config = {
        ...valid,
        models: [
          { id: 'm1', label: 'M1', effort: 'high', providerOrder: ['deepseek'], tier: 'normal' },
        ],
      } as ProviderConfig;
      const reg = createProviderRegistry([config], { secrets: {} });
      expect(reg.list()[0]!.models).toEqual([{ id: 'm1', label: 'M1', tier: 'normal' }]);
      // The provider itself keeps them (it sends them; the meter logs them).
      expect(reg.get(config.id)!.models()[0]).toMatchObject({ effort: 'high' });
    });

    it('defaults defaultModel to the first model', () => {
      const { defaultModel: _d, ...rest } = valid;
      expect(parseProviderConfigs(JSON.stringify([rest]))[0]!.defaultModel).toBe('m1');
    });

    it('accepts openModels, whose default need not be listed, and surfaces it in list()', () => {
      const open = { ...valid, openModels: true, defaultModel: 'vendor/any-model:free' };
      const configs = parseProviderConfigs(JSON.stringify([open, { ...valid, id: 'y' }]));
      expect(configs[0]).toEqual(open);
      const reg = createProviderRegistry(configs, { secrets: {} });
      expect(reg.list().map((p) => [p.id, p.openModels])).toEqual([
        ['x', true],
        ['y', false],
      ]);
    });

    it('accepts a model tier and surfaces it in list()', () => {
      const tiered = {
        ...valid,
        models: [
          { id: 'm1', label: 'M1', tier: 'normal' },
          { id: 'm2', label: 'M2', tier: 'max' },
          { id: 'm3', label: 'M3' },
        ],
      };
      const configs = parseProviderConfigs(JSON.stringify([tiered]));
      expect(configs[0]!.models).toEqual(tiered.models);
      const reg = createProviderRegistry(configs, { secrets: {} });
      expect(reg.list()[0]!.models.map((m) => m.tier)).toEqual(['normal', 'max', undefined]);
    });

    it.each([
      ['not json', '{', /not valid JSON/],
      [
        'bad tier',
        JSON.stringify([{ ...valid, models: [{ id: 'm1', label: 'M1', tier: 'premium' }] }]),
        /models\[0\]\.tier must be "normal" or "max"/,
      ],
      [
        'configured usageFactor',
        JSON.stringify([{ ...valid, models: [{ id: 'm1', label: 'M1', usageFactor: 3 }] }]),
        /models\[0\]\.usageFactor is not a known field/,
      ],
      [
        'openModels not a boolean',
        JSON.stringify([{ ...valid, openModels: 'yes' }]),
        /openModels must be a boolean/,
      ],
      [
        'open default not a model id',
        JSON.stringify([{ ...valid, openModels: true, defaultModel: 'bad id' }]),
        /defaultModel "bad id" is not a valid model id/,
      ],
      ['not an array', '{}', /must be a JSON array/],
      ['empty', '[]', /at least one provider/],
      [
        'unknown kind',
        JSON.stringify([{ ...valid, kind: 'gemini' }]),
        /PROVIDERS\[0\]\.kind must be one of/,
      ],
      [
        'duplicate ids',
        JSON.stringify([valid, valid]),
        /PROVIDERS\[1\]\.id duplicates provider id "x"/,
      ],
      [
        'defaultModel not in models',
        JSON.stringify([{ ...valid, defaultModel: 'm2' }]),
        /defaultModel "m2" is not one of its models/,
      ],
      [
        'missing id',
        JSON.stringify([{ ...valid, id: '' }]),
        /PROVIDERS\[0\]\.id must be a non-empty string/,
      ],
      [
        'bad url',
        JSON.stringify([{ ...valid, baseUrl: 'not a url' }]),
        /baseUrl must be an absolute URL/,
      ],
      [
        'bad tokens',
        JSON.stringify([{ ...valid, maxOutputTokens: -1 }]),
        /maxOutputTokens must be a positive integer/,
      ],
      [
        'bad header',
        JSON.stringify([{ ...valid, headers: { a: 1 } }]),
        /headers\.a must be a non-empty string/,
      ],
      [
        'unknown field',
        JSON.stringify([{ ...valid, apiKey: 'sk-oops' }]),
        /PROVIDERS\[0\]\.apiKey is not a known field/,
      ],
      [
        'bad model',
        JSON.stringify([{ ...valid, models: [{ id: 'm1' }] }]),
        /models\[0\]\.label must be a non-empty string/,
      ],
      [
        'bad extraBody',
        JSON.stringify([{ ...valid, options: { extraBody: [1] } }]),
        /options\.extraBody must be an object/,
      ],
      [
        'no model at all',
        JSON.stringify([{ id: 'f', kind: 'fake', label: 'F' }]),
        /defaultModel is required/,
      ],
    ])('rejects %s', (_name, json, message) => {
      expect(() => parseProviderConfigs(json)).toThrow(message);
    });
  });
});
