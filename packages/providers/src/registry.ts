import type {
  LlmProvider,
  ModelInfo,
  ProviderConfig,
  ProviderError,
  ProviderInfo,
  ProviderKind,
  ProviderRegistry,
} from '@tangent/shared';
import { createAnthropicProvider } from './anthropic.js';
import { createFakeProvider } from './fake.js';
import { createOpenAiCompatibleProvider } from './openai-compatible.js';
import {
  ProviderFailure,
  guardStream,
  isRecord,
  missingSecretError,
  providerError,
  resolveApiKey,
} from './internal.js';

export interface ProviderEnv {
  /** Secret name → value (Worker secrets / process.env). */
  secrets: Readonly<Record<string, string | undefined>>;
  /**
   * Provider id → API key supplied by the user for this request
   * (bring-your-own-key). Takes precedence over `apiKeySecret`.
   */
  apiKeys?: Readonly<Record<string, string>>;
  /** Injected fetch (tests). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

export type ProviderFactory = (config: ProviderConfig, env: ProviderEnv) => LlmProvider;

/** The one place new provider kinds are registered. */
export const PROVIDER_FACTORIES: Record<ProviderKind, ProviderFactory> = {
  anthropic: createAnthropicProvider,
  'openai-compatible': createOpenAiCompatibleProvider,
  fake: createFakeProvider,
};

const KINDS = Object.keys(PROVIDER_FACTORIES) as ProviderKind[];

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'id',
  'kind',
  'label',
  'baseUrl',
  'apiKeySecret',
  'headers',
  'extraHeaderSecrets',
  'models',
  'defaultModel',
  'maxContextTokens',
  'maxOutputTokens',
  'supportsSystemPrompt',
  'options',
]);
const MODEL_KEYS: ReadonlySet<string> = new Set(['id', 'label', 'maxContextTokens', 'maxOutputTokens']);

class ConfigError extends Error {
  constructor(path: string, problem: string) {
    super(`Invalid provider config: ${path} ${problem}`);
    this.name = 'ProviderConfigError';
  }
}

function reqString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim() === '') throw new ConfigError(`${path}.${key}`, 'must be a non-empty string');
  return v;
}

function optString(obj: Record<string, unknown>, key: string, path: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.trim() === '') throw new ConfigError(`${path}.${key}`, 'must be a non-empty string');
  return v;
}

function optPositiveInt(obj: Record<string, unknown>, key: string, path: string): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ConfigError(`${path}.${key}`, 'must be a positive integer');
  }
  return v;
}

function optStringRecord(obj: Record<string, unknown>, key: string, path: string): Record<string, string> | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw new ConfigError(`${path}.${key}`, 'must be an object of strings');
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string' || val === '') throw new ConfigError(`${path}.${key}.${k}`, 'must be a non-empty string');
    out[k] = val;
  }
  return out;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new ConfigError(`${path}.${k}`, 'is not a known field');
  }
}

function parseModel(v: unknown, path: string): ModelInfo {
  if (!isRecord(v)) throw new ConfigError(path, 'must be an object');
  rejectUnknownKeys(v, MODEL_KEYS, path);
  const m: ModelInfo = { id: reqString(v, 'id', path), label: reqString(v, 'label', path) };
  const ctx = optPositiveInt(v, 'maxContextTokens', path);
  if (ctx !== undefined) m.maxContextTokens = ctx;
  const out = optPositiveInt(v, 'maxOutputTokens', path);
  if (out !== undefined) m.maxOutputTokens = out;
  return m;
}

function parseConfig(v: unknown, path: string): ProviderConfig {
  if (!isRecord(v)) throw new ConfigError(path, 'must be an object');
  rejectUnknownKeys(v, CONFIG_KEYS, path);
  const id = reqString(v, 'id', path);
  const kind = v['kind'];
  if (typeof kind !== 'string' || !(KINDS as string[]).includes(kind)) {
    throw new ConfigError(`${path}.kind`, `must be one of ${KINDS.map((k) => `"${k}"`).join(', ')}`);
  }
  const label = reqString(v, 'label', path);

  const modelsRaw = v['models'] ?? [];
  if (!Array.isArray(modelsRaw)) throw new ConfigError(`${path}.models`, 'must be an array');
  const models = modelsRaw.map((m, i) => parseModel(m, `${path}.models[${i}]`));
  const modelIds = new Set<string>();
  for (const m of models) {
    if (modelIds.has(m.id)) throw new ConfigError(`${path}.models`, `has duplicate model id "${m.id}"`);
    modelIds.add(m.id);
  }

  let defaultModel = optString(v, 'defaultModel', path);
  if (defaultModel === undefined) {
    const first = models[0];
    if (!first) throw new ConfigError(`${path}.defaultModel`, 'is required when models is empty');
    defaultModel = first.id;
  }
  if (models.length > 0 && !modelIds.has(defaultModel)) {
    throw new ConfigError(`${path}.defaultModel`, `"${defaultModel}" is not one of its models`);
  }

  const config: ProviderConfig = { id, kind: kind as ProviderKind, label, models, defaultModel };

  const baseUrl = optString(v, 'baseUrl', path);
  if (baseUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new ConfigError(`${path}.baseUrl`, 'must be an absolute URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ConfigError(`${path}.baseUrl`, 'must be an http(s) URL');
    }
    config.baseUrl = baseUrl;
  }
  const apiKeySecret = optString(v, 'apiKeySecret', path);
  if (apiKeySecret !== undefined) config.apiKeySecret = apiKeySecret;
  const headers = optStringRecord(v, 'headers', path);
  if (headers !== undefined) config.headers = headers;
  const extra = optStringRecord(v, 'extraHeaderSecrets', path);
  if (extra !== undefined) config.extraHeaderSecrets = extra;
  const ctx = optPositiveInt(v, 'maxContextTokens', path);
  if (ctx !== undefined) config.maxContextTokens = ctx;
  const out = optPositiveInt(v, 'maxOutputTokens', path);
  if (out !== undefined) config.maxOutputTokens = out;
  const sys = v['supportsSystemPrompt'];
  if (sys !== undefined) {
    if (typeof sys !== 'boolean') throw new ConfigError(`${path}.supportsSystemPrompt`, 'must be a boolean');
    config.supportsSystemPrompt = sys;
  }
  const options = v['options'];
  if (options !== undefined) {
    if (!isRecord(options)) throw new ConfigError(`${path}.options`, 'must be an object');
    const extraBody = options['extraBody'];
    if (extraBody !== undefined && !isRecord(extraBody)) {
      throw new ConfigError(`${path}.options.extraBody`, 'must be an object');
    }
    config.options = options;
  }
  return config;
}

/** Validates and parses a JSON array of ProviderConfig (e.g. the PROVIDERS var). */
export function parseProviderConfigs(json: string): ProviderConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid provider config: not valid JSON (${e instanceof Error ? e.message : String(e)})`, {
      cause: e,
    });
  }
  if (!Array.isArray(raw)) throw new ConfigError('PROVIDERS', 'must be a JSON array');
  if (raw.length === 0) throw new ConfigError('PROVIDERS', 'must contain at least one provider');
  const configs = raw.map((c, i) => parseConfig(c, `PROVIDERS[${i}]`));
  const ids = new Set<string>();
  configs.forEach((c, i) => {
    if (ids.has(c.id)) throw new ConfigError(`PROVIDERS[${i}].id`, `duplicates provider id "${c.id}"`);
    ids.add(c.id);
  });
  return configs;
}

/**
 * Built-in defaults when no PROVIDERS var is set: anthropic (ANTHROPIC_API_KEY),
 * openai (OPENAI_API_KEY), openrouter (OPENROUTER_API_KEY), fake.
 */
export const DEFAULT_PROVIDER_CONFIGS: ProviderConfig[] = [
  {
    id: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic',
    apiKeySecret: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-5-5',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },
  {
    id: 'openai',
    kind: 'openai-compatible',
    label: 'OpenAI',
    apiKeySecret: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5',
    models: [
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
    ],
  },
  {
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeySecret: 'OPENROUTER_API_KEY',
    defaultModel: 'anthropic/claude-sonnet-5.5',
    models: [
      { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5 (OpenRouter)' },
      { id: 'openai/gpt-5', label: 'GPT-5 (OpenRouter)' },
    ],
  },
  {
    id: 'fake',
    kind: 'fake',
    label: 'Fake (offline)',
    defaultModel: 'fake-1',
    models: [{ id: 'fake-1', label: 'Fake 1' }],
  },
];

/** Why this config can't be used with `env`, or undefined when it is available. */
function unavailableReason(config: ProviderConfig, env: ProviderEnv): ProviderError | undefined {
  for (const name of Object.values(config.extraHeaderSecrets ?? {})) {
    if (!env.secrets[name]) return missingSecretError(name);
  }
  if (config.kind === 'fake') return undefined;
  if (resolveApiKey(config, env)) return undefined;
  if (config.apiKeySecret) return env.secrets[config.apiKeySecret] ? undefined : missingSecretError(config.apiKeySecret);
  // No key configured: only a keyless local/self-hosted OpenAI-compatible server is usable.
  if (config.kind === 'openai-compatible' && config.baseUrl) return undefined;
  return providerError('config', `Provider "${config.id}" has no apiKeySecret configured`);
}

/** Keeps metadata/capabilities of the real provider, but every call fails with a config error. */
function unavailableProvider(inner: LlmProvider, error: ProviderError): LlmProvider {
  return {
    id: inner.id,
    kind: inner.kind,
    label: inner.label,
    models: () => inner.models(),
    defaultModel: () => inner.defaultModel(),
    capabilities: (model) => inner.capabilities(model),
    stream: (request) =>
      guardStream(request.signal, [], async function* () {
        yield { type: 'error', error: { ...error } };
      }),
    ...(inner.countTokens ? { countTokens: () => Promise.reject(new ProviderFailure({ ...error })) } : {}),
  };
}

/** Whether a user-supplied key can be used with this config (every kind but fake). */
export function acceptsUserKey(config: Pick<ProviderConfig, 'kind'>): boolean {
  return config.kind !== 'fake';
}

function keySourceOf(config: ProviderConfig, env: ProviderEnv): ProviderInfo['keySource'] {
  if (!acceptsUserKey(config)) return null;
  if (env.apiKeys?.[config.id]) return 'user';
  if (config.apiKeySecret && env.secrets[config.apiKeySecret]) return 'server';
  return null;
}

/**
 * A provider is `available` when its kind needs no key (fake), the caller
 * supplied a key for it (`env.apiKeys`) or its apiKeySecret resolves to a
 * non-empty secret. Unavailable providers are
 * still listed (so the UI can explain), but `get` returns an instance whose
 * stream yields error{code:'config'}.
 */
export function createProviderRegistry(configs: readonly ProviderConfig[], env: ProviderEnv): ProviderRegistry {
  if (configs.length === 0) throw new Error('Invalid provider config: no providers configured');
  const entries = new Map<
    string,
    { config: ProviderConfig; provider: LlmProvider; available: boolean; keySource: ProviderInfo['keySource'] }
  >();
  for (const config of configs) {
    if (entries.has(config.id)) throw new Error(`Invalid provider config: duplicate provider id "${config.id}"`);
    const factory = PROVIDER_FACTORIES[config.kind];
    const real = factory(config, env);
    const reason = unavailableReason(config, env);
    entries.set(config.id, {
      config,
      provider: reason === undefined ? real : unavailableProvider(real, reason),
      available: reason === undefined,
      keySource: keySourceOf(config, env),
    });
  }
  const all = [...entries.values()];
  const defaultId =
    all.find((e) => e.available && e.config.kind !== 'fake')?.config.id ??
    all.find((e) => e.config.kind === 'fake')?.config.id ??
    all[0]!.config.id;

  return {
    get: (providerId) => entries.get(providerId)?.provider,
    list: () =>
      all.map(({ config, provider, available, keySource }) => ({
        id: provider.id,
        kind: provider.kind,
        label: provider.label,
        models: provider.models(),
        defaultModel: provider.defaultModel(),
        available,
        acceptsUserKey: acceptsUserKey(config),
        keySource,
      })),
    defaultProviderId: () => defaultId,
  };
}

