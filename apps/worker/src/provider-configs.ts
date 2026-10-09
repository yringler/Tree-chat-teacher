// Which providers a deployment configures, and the secrets their code may
// read: a leaf, shared by the registries (registries.ts), the feature
// predicates (availability.ts) and the key routes.
import {
  DEFAULT_PROVIDER_CONFIGS,
  parseProviderConfigs,
  type ProviderEnv,
} from '@tangent/providers';
import { LEARN_KEY_PROVIDER, type ProviderConfig } from '@tangent/shared';
import { appConfig, namedSecrets } from './config.js';
import type { AppEnv } from './env.js';
import { suggestedModels } from './simple-mode.js';

/** Provider id → user-supplied API key (bring-your-own-key, see byok/keys.ts). */
export type UserApiKeys = Readonly<Record<string, string>>;

/**
 * Power-mode provider configs, for the user's own keys: the PROVIDERS var, or
 * the defaults with OpenRouter opened up (`openrouterWithSuggestions`). The
 * built-in provider is not one of them: Tangent credit is a registry of its
 * own (`creditRegistryFor`), even where both name the endpoint `openrouter`.
 */
export function providerConfigs(env: AppEnv): ProviderConfig[] {
  const providers = appConfig(env).power.providers;
  if (!providers) {
    return DEFAULT_PROVIDER_CONFIGS.map((c) =>
      c.id === LEARN_KEY_PROVIDER ? openrouterWithSuggestions(env, c) : c,
    );
  }
  return parseProviderConfigs(providers);
}

/**
 * The default `openrouter` config with the suggested models (Learn's Normal and
 * Max, tagged with their tier) first, Normal as its default, and any model id
 * allowed: the easy way to use the suggested defaults on one's own OpenRouter key.
 */
function openrouterWithSuggestions(env: AppEnv, config: ProviderConfig): ProviderConfig {
  const suggested = suggestedModels(env);
  const ids = new Set(suggested.map((m) => m.id));
  return {
    ...config,
    models: [...suggested, ...config.models.filter((m) => !ids.has(m.id))],
    defaultModel: suggested[0]!.id,
    openModels: true,
  };
}

/**
 * The secrets `configs` name (`apiKeySecret`, `extraHeaderSecrets`), and no
 * others: secrets and vars share the env object, and the app's own (auth,
 * payments, cookie sealing) never reach provider code. `withheld` names
 * secrets this request may not use (the operator's keys, see registryFor):
 * providers that need one then report unavailable, or take the user's key.
 */
export function providerEnv(
  env: AppEnv,
  configs: readonly ProviderConfig[],
  apiKeys?: UserApiKeys,
  withheld: ReadonlySet<string> = new Set(),
): ProviderEnv {
  const named = new Set(
    [
      ...apiKeySecrets(configs),
      ...configs.flatMap((c) => Object.values(c.extraHeaderSecrets ?? {})),
    ].filter((name) => !withheld.has(name)),
  );
  const secrets = namedSecrets(env, named);
  return apiKeys ? { secrets, apiKeys } : { secrets };
}

export function apiKeySecrets(configs: readonly ProviderConfig[]): string[] {
  return configs.flatMap((c) => (c.apiKeySecret ? [c.apiKeySecret] : []));
}
