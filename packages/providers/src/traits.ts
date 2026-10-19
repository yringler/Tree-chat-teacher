import type { ProviderConfig, ProviderKind } from '@tangent/shared';
import { isOpenAiBaseUrl, isOpenRouterBaseUrl } from './internal.js';
import { usesExplicitCacheControl } from './prompt-cache.js';

/**
 * How a provider runs a web search: `native`, the vendor's own search tool;
 * `router`, OpenRouter's `openrouter:web_search` server tool, whose engine
 * and result count are request options (so the operator's grounding vars
 * apply to it); `none`, not at all: another openai-compatible endpoint
 * (OpenAI's own API, a gateway, a local server) rejects OpenRouter's tool,
 * so a config there can't enable `options.webSearch`.
 */
export type WebSearchMode = 'native' | 'router' | 'none';

/**
 * How a call's reasoning effort is sent: OpenRouter's `reasoning` object,
 * Anthropic's `output_config.effort`, OpenAI's `reasoning_effort`, or not at
 * all. Another openai-compatible base URL (a gateway, a local server) gets
 * none: what it accepts is unknown, and a strict server rejects an unknown
 * field with a 400.
 */
export type EffortParam =
  'openrouter-reasoning' | 'anthropic-effort' | 'openai-reasoning_effort' | 'none';

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
 * openai-compatible config is OpenRouter's (search, reasoning, routing,
 * catalog) only on a base URL that reaches it, directly or through AI
 * Gateway's OpenRouter route.
 */
export function providerTraits(config: ProviderConfig): ProviderTraits {
  switch (config.kind) {
    case 'anthropic':
      return {
        ...NONE,
        webSearch: 'native',
        effort: 'anthropic-effort',
        explicitCacheMarkers: () => true,
      };
    case 'fake':
      return { ...NONE, webSearch: 'native', explicitCacheMarkers: () => false };
    case 'openai-compatible': {
      const base = { explicitCacheMarkers: usesExplicitCacheControl } as const;
      if (isOpenRouterBaseUrl(config.baseUrl))
        return {
          ...base,
          webSearch: 'router',
          effort: 'openrouter-reasoning',
          routing: true,
          catalog: 'openrouter',
        };
      return isOpenAiBaseUrl(config.baseUrl)
        ? { ...base, ...NONE, webSearch: 'none', effort: 'openai-reasoning_effort' }
        : { ...base, ...NONE, webSearch: 'none' };
    }
  }
}

/** Anthropic's web search fee: $10 per 1,000 searches, billed per search it ran. */
export const ANTHROPIC_WEB_SEARCH_FEE_MICROS = 10_000;

/**
 * The fee of one web search that a provider of `kind` bills outside any cost
 * it reports, which the meter adds to a call's tokens: Anthropic reports no
 * cost, only the count (`billing.webSearches`). OpenRouter's reported cost
 * already holds its search fee, so other kinds add nothing.
 */
export function unreportedSearchFeeMicros(kind: ProviderKind): number {
  return kind === 'anthropic' ? ANTHROPIC_WEB_SEARCH_FEE_MICROS : 0;
}
