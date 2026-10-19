// The OpenRouter backend: logical ids are its own, it reports each call's
// cost (search fee included) and can look a generation's cost up afterwards.
// It serves every model, so a call no other listed backend can serve runs here.
import { fetchOpenRouterGeneration } from '@tangent/providers';
import type { ProviderConfig } from '@tangent/shared';
import { appConfig, BUILT_IN_API_KEY_SECRET, namedSecrets, type ModelPrice } from '../config.js';
import type { AppEnv } from '../env.js';
import type { GenerationLookup, HostedBackend, HostedEndpoint } from './backend.js';

const ENDPOINT: HostedEndpoint = {
  kind: 'openai-compatible',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKeySecret: BUILT_IN_API_KEY_SECRET,
  // OpenRouter's web search server tool (grounding, see billing/grounding.ts).
  options: { webSearch: true },
};

export const openRouterBackend: HostedBackend & { fetchGeneration: GenerationLookup } = {
  id: 'openrouter',
  config: () => ENDPOINT,
  apiKey: builtInApiKey,
  modelId: (logical) => logical,
  cost: 'reported',
  fetchGeneration: fetchOpenRouterGeneration,
  // OpenRouter's credit-purchase fee: part of what the open pool's calls truly cost.
  feeBps: (env, price) => price.feeBps ?? appConfig(env).billing.openRouterFeeBps,
};

/**
 * The OpenRouter key the built-in provider spends: the secret named by
 * `BUILT_IN_PROVIDER.apiKeySecret` when set, else `BUILT_IN_API_KEY`.
 */
export function builtInApiKey(env: AppEnv): string | null {
  let secretName = BUILT_IN_API_KEY_SECRET;
  const override = appConfig(env).builtIn.provider;
  if (override) {
    try {
      const parsed: unknown = JSON.parse(override);
      const config: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
      if (typeof config === 'object' && config !== null) {
        const name = (config as Record<string, unknown>)['apiKeySecret'];
        if (typeof name === 'string' && name) secretName = name;
      }
    } catch {
      // Invalid BUILT_IN_PROVIDER fails loudly where the registry is built; keep the default here.
    }
  }
  const value = namedSecrets(env, new Set([secretName]))[secretName];
  return value?.trim() || null;
}

/**
 * `config` with OpenRouter's routing capped at `price` (`provider.max_price`,
 * $/MTok), so an over-priced route fails upstream (released) instead of
 * costing the operator. Merged into the operator's own routing (e.g.
 * `data_collection: 'deny'`), keeping a stricter `max_price` they set.
 */
export function withMaxPrice(config: ProviderConfig, price: ModelPrice): ProviderConfig {
  const extraBody = asRecord(config.options?.['extraBody']);
  const routing = asRecord(extraBody['provider']);
  const priorMax = asRecord(routing['max_price']);
  return {
    ...config,
    options: {
      ...config.options,
      extraBody: {
        ...extraBody,
        provider: {
          ...routing,
          max_price: {
            ...priorMax,
            prompt: lowerPrice(priorMax['prompt'], price.inMicrosPerMTok / 1_000_000),
            completion: lowerPrice(priorMax['completion'], price.outMicrosPerMTok / 1_000_000),
          },
        },
      },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The operator's price cap when it is a stricter number, else the pool's. */
function lowerPrice(prior: unknown, pool: number): number {
  return typeof prior === 'number' && Number.isFinite(prior) && prior >= 0
    ? Math.min(prior, pool)
    : pool;
}
