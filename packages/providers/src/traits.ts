import type { ProviderConfig } from '@tangent/shared';
import { isOpenRouterBaseUrl } from './internal.js';
import { usesExplicitCacheControl } from './prompt-cache.js';

/**
 * How a provider runs a web search: `native`, the vendor's own search tool;
 * `router`, OpenRouter's `openrouter:web_search` server tool, whose engine
 * and result count are request options (so the operator's grounding vars
 * apply to it).
 */
export type WebSearchMode = 'native' | 'router';

/** How a call's reasoning effort is sent: OpenRouter's `reasoning` object, or not at all. */
export type EffortParam = 'openrouter-reasoning' | 'none';

/**
 * What a provider config's endpoint does beyond the common chat contract, so
 * code holding a config (not a provider) asks this instead of testing the
 * kind or the base URL itself.
 */
export interface ProviderTraits {
  webSearch: WebSearchMode;
  effort: EffortParam;
  /** Whether `model` caches only with explicit `cache_control` breakpoints. */
  explicitCacheMarkers(model: string): boolean;
  /**
   * The endpoint routes each request to a host it picks, and takes routing
   * fields (`provider.order`, `provider.max_price`); other endpoints may
   * reject them.
   */
  routing: boolean;
  /** Whose model list the endpoint's ids, context windows and list prices come from. */
  catalog: 'openrouter' | null;
}

const NONE = {
  effort: 'none',
  routing: false,
  catalog: null,
} as const satisfies Partial<ProviderTraits>;

/**
 * The traits of `config`'s endpoint: a pure function of the config. An
 * openai-compatible config searches through OpenRouter's server tool on any
 * base URL (a proxy in front of OpenRouter isn't recognisable by its URL);
 * the rest is OpenRouter's only on a base URL that reaches it.
 */
export function providerTraits(config: ProviderConfig): ProviderTraits {
  switch (config.kind) {
    case 'anthropic':
      return { ...NONE, webSearch: 'native', explicitCacheMarkers: () => true };
    case 'fake':
      return { ...NONE, webSearch: 'native', explicitCacheMarkers: () => false };
    case 'openai-compatible': {
      const base = { webSearch: 'router', explicitCacheMarkers: usesExplicitCacheControl } as const;
      return isOpenRouterBaseUrl(config.baseUrl)
        ? { ...base, effort: 'openrouter-reasoning', routing: true, catalog: 'openrouter' }
        : { ...base, ...NONE };
    }
  }
}
