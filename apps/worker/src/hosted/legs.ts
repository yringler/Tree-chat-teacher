// The legs of a metered built-in call: its chain (registry.ts), each backend
// with the provider that streams on it. The built-in provider's own config is
// OpenRouter's endpoint (or the BUILT_IN_PROVIDER override that replaces
// it), so an OpenRouter leg streams on that provider as it is: the pool's
// `max_price`, its pinned hosts and the grounding options included. Another
// backend's leg streams on a provider built from that backend's endpoint and
// key, asking the call's model by the backend's id with the request settings
// the built-in config gives the logical model; OpenRouter's routing fields
// stay behind. Only metered calls (on the operator's key) get legs: a call on
// a user's own key runs on the provider it was given and never reaches these keys.
import { createProviderRegistry } from '@tangent/providers';
import type { LlmProvider, ModelInfo, ProviderConfig } from '@tangent/shared';
import type { AppEnv } from '../env.js';
import { providerEnv } from '../provider-configs.js';
import type { HostedBackend } from './backend.js';
import { openRouterBackend } from './openrouter.js';
import { hostedChain } from './registry.js';

/** One backend a metered call can run on, and the provider that streams it there. */
export interface HostedLeg {
  backend: HostedBackend;
  /** The backend's id of the call's model: the model the request upstream asks for. */
  model: string;
  provider: LlmProvider;
}

/** The legs of a call on `logical` through the built-in `provider`, first choice first (never empty). */
export type LegsOf = (provider: LlmProvider, logical: string) => HostedLeg[];

/** One leg: the call on `provider` itself, as OpenRouter's. */
export const singleLeg: LegsOf = (provider, logical) => [
  { backend: openRouterBackend, model: logical, provider },
];

/**
 * The legs of `env`'s metered built-in calls (`hostedChain`), for one
 * registry's built-in provider: each other backend's provider is built once.
 */
export function hostedLegs(env: AppEnv): LegsOf {
  const built = new Map<string, LlmProvider>();
  return (provider, logical) =>
    hostedChain(env, logical).map(({ backend, model }) => {
      if (backend === openRouterBackend) return { backend, model, provider };
      const key = `${backend.id}\n${model}`;
      let leg = built.get(key);
      if (!leg) {
        const config = legConfig(provider, logical, backend, model);
        leg = createProviderRegistry([config], providerEnv(env, [config])).get(config.id)!;
        built.set(key, leg);
      }
      return { backend, model, provider: leg };
    });
}

/**
 * The config of a leg on `backend` of a call on `logical` through `provider`:
 * the backend's endpoint and key, the model by `model` (the backend's id)
 * with the logical model's effort and limits, and no OpenRouter routing
 * (`providerOrder`, the `max_price` in the endpoint's options).
 */
export function legConfig(
  provider: LlmProvider,
  logical: string,
  backend: HostedBackend,
  model: string,
): ProviderConfig {
  const listed = provider.models().find((m) => m.id === logical);
  const caps = provider.capabilities(logical);
  const info: ModelInfo = {
    id: model,
    label: listed?.label ?? model,
    ...(listed?.effort !== undefined ? { effort: listed.effort } : {}),
    ...(listed?.reasoning !== undefined ? { reasoning: listed.reasoning } : {}),
  };
  return {
    id: provider.id,
    label: provider.label,
    ...backend.config(),
    models: [info],
    defaultModel: model,
    maxContextTokens: caps.maxContextTokens,
    maxOutputTokens: caps.maxOutputTokens,
  };
}
