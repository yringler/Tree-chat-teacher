// Which providers a deployment configures, and the secrets their code may
// read: a leaf, shared by the registries (registries.ts), the feature
// predicates (availability.ts) and the key routes.
import {
  DEFAULT_PROVIDER_CONFIGS,
  parseProviderConfigs,
  type ProviderEnv,
} from '@tangent/providers';
import {
  ANTHROPIC_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
  type LearnKeyProvider,
  type ProviderConfig,
} from '@tangent/shared';
import { appConfig, namedSecrets } from './config.js';
import type { AppEnv } from './env.js';
import {
  LEARN_ANTHROPIC_REPLY_MODEL,
  simpleProviderConfig,
  suggestedModels,
} from './simple-mode.js';

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
      c.id === OPENROUTER_PROVIDER_ID ? openrouterWithSuggestions(env, c) : c,
    );
  }
  return parseProviderConfigs(providers);
}

/**
 * The default `openrouter` config with the suggested models (Normal and Max,
 * tagged with their tier) first, Normal as its default, and any model id
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
 * The config Learn replies through on the learner's own `key`: the built-in
 * provider's (`simpleProviderConfig`) for OpenRouter; for Anthropic, power's
 * `anthropic` endpoint (so a key saved in either app is checked against, and
 * used on, the same endpoint) with LEARN_ANTHROPIC_REPLY_MODEL as its only
 * model. Null where the deployment has no Anthropic endpoint of that kind.
 */
export function learnKeyConfig(env: AppEnv, key: LearnKeyProvider): ProviderConfig | null {
  if (key === OPENROUTER_PROVIDER_ID) return simpleProviderConfig(env);
  const power = providerConfigs(env).find(
    (c) => c.id === ANTHROPIC_PROVIDER_ID && c.kind === 'anthropic',
  );
  if (!power) return null;
  const listed = power.models.find((m) => m.id === LEARN_ANTHROPIC_REPLY_MODEL);
  return {
    ...power,
    defaultModel: LEARN_ANTHROPIC_REPLY_MODEL,
    models: [listed ?? { id: LEARN_ANTHROPIC_REPLY_MODEL, label: 'Claude Sonnet' }],
    openModels: false,
  };
}

/** The own keys Learn can reply on in this deployment (`KeyStatusResponse.learnProviders`). */
export function learnKeyProviders(env: AppEnv): LearnKeyProvider[] {
  return learnKeyConfig(env, ANTHROPIC_PROVIDER_ID)
    ? [OPENROUTER_PROVIDER_ID, ANTHROPIC_PROVIDER_ID]
    : [OPENROUTER_PROVIDER_ID];
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
