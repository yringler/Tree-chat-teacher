import type { LlmProvider, ProviderConfig, ProviderKind, ProviderRegistry } from '@tangent/shared';

export interface ProviderEnv {
  /** Secret name → value (Worker secrets / process.env). */
  secrets: Readonly<Record<string, string | undefined>>;
  /** Injected fetch (tests). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

export type ProviderFactory = (config: ProviderConfig, env: ProviderEnv) => LlmProvider;

/** The one place new provider kinds are registered. */
export declare const PROVIDER_FACTORIES: Record<ProviderKind, ProviderFactory>;

/** Validates and parses a JSON array of ProviderConfig (e.g. the PROVIDERS var). */
export function parseProviderConfigs(json: string): ProviderConfig[] {
  void json;
  throw new Error('not implemented');
}

/**
 * Built-in defaults when no PROVIDERS var is set: anthropic (ANTHROPIC_API_KEY),
 * openai (OPENAI_API_KEY), openrouter (OPENROUTER_API_KEY), fake.
 */
export declare const DEFAULT_PROVIDER_CONFIGS: ProviderConfig[];

/**
 * A provider is `available` when its kind needs no key (fake) or its
 * apiKeySecret resolves to a non-empty secret. Unavailable providers are
 * still listed (so the UI can explain), but `get` returns an instance whose
 * stream yields error{code:'config'}.
 */
export function createProviderRegistry(configs: readonly ProviderConfig[], env: ProviderEnv): ProviderRegistry {
  void configs;
  void env;
  throw new Error('not implemented');
}
