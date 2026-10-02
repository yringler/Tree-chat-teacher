import { ChatService, DEFAULT_CHAT_SETTINGS, ShareService, type ChatSettings } from '@tangent/core';
import {
  createProviderRegistry,
  DEFAULT_PROVIDER_CONFIGS,
  parseProviderConfigs,
  type ProviderEnv,
} from '@tangent/providers';
import {
  DEFAULT_SYSTEM_PROMPT,
  LEARN_KEY_PROVIDER,
  type ProviderConfig,
  type ProviderRegistry,
} from '@tangent/shared';
import { createUsageMeter, meteredRegistry } from './billing/meter.js';
import { billingConfigured } from './billing/stripe.js';
import { createD1Repositories } from './db/d1-repositories.js';
import { isMetered, type AccountContext, type AppEnv } from './env.js';
import { simpleChatSettings, simpleProviderConfig, simpleSystemPrompt } from './simple-mode.js';

/** Provider id → user-supplied API key (bring-your-own-key, see byok/keys.ts). */
export type UserApiKeys = Readonly<Record<string, string>>;

/** Keeps background work alive past the response (`waitUntil` of the Worker or the Durable Object). */
export type Defer = (p: Promise<unknown>) => void;

/** Power-mode provider configs (the PROVIDERS var, or the built-in defaults). */
export function providerConfigs(env: AppEnv): ProviderConfig[] {
  return env.PROVIDERS?.trim() ? parseProviderConfigs(env.PROVIDERS) : DEFAULT_PROVIDER_CONFIGS;
}

/**
 * Secrets and vars share the env object; providers look up only the names
 * they are configured with. `withheld` names secrets this request may not
 * use (the operator's keys, see registryFor): providers that need one then
 * report unavailable, or take the user's key.
 */
export function providerEnv(
  env: AppEnv,
  apiKeys?: UserApiKeys,
  withheld: ReadonlySet<string> = new Set(),
): ProviderEnv {
  const secrets: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    // The cookie-sealing secret is never a provider credential.
    if (typeof v === 'string' && k !== 'KEY_ENCRYPTION_SECRET' && !withheld.has(k)) secrets[k] = v;
  }
  return apiKeys ? { secrets, apiKeys } : { secrets };
}

/** The secret behind paid Learn mode; never reachable from power mode. */
const SIMPLE_KEY_SECRET = 'OPENROUTER_SIMPLE_API_KEY';

function apiKeySecrets(configs: readonly ProviderConfig[]): string[] {
  return configs.flatMap((c) => (c.apiKeySecret ? [c.apiKeySecret] : []));
}

/**
 * True when Learn mode can run on paid credit: billing is configured and the
 * `tangent` provider is usable with the operator's key. Otherwise Learn mode
 * is bring-your-own-key only and the paid option is hidden.
 */
export function paidCreditAvailable(env: AppEnv): boolean {
  if (!billingConfigured(env)) return false;
  const registry = createProviderRegistry([simpleProviderConfig(env)], providerEnv(env));
  return registry.list()[0]?.available ?? false;
}

/**
 * The providers a request may use. Anyone can sign up, so the operator's keys
 * are withheld unless `account.operatorKeys`:
 * - simple, paid credit: only the `tangent` provider on the operator's key
 *   (metered by chatService); user keys are ignored.
 * - simple, own key: the same provider config, on the user's OpenRouter key
 *   (key cookie entry LEARN_KEY_PROVIDER) and never the operator's.
 * - power: the configured providers, user keys overriding server secrets.
 *   Server secrets only for operatorKeys (the local dev bypass), and
 *   never the paid-Learn key.
 */
export function registryFor(
  env: AppEnv,
  account: AccountContext,
  apiKeys?: UserApiKeys,
): ProviderRegistry {
  if (account.mode === 'simple') {
    const config = simpleProviderConfig(env);
    if (account.operatorKeys) return createProviderRegistry([config], providerEnv(env));
    const own = apiKeys?.[LEARN_KEY_PROVIDER];
    return createProviderRegistry(
      [config],
      providerEnv(
        env,
        own ? { [config.id]: own } : undefined,
        new Set([SIMPLE_KEY_SECRET, ...apiKeySecrets([config])]),
      ),
    );
  }
  const configs = providerConfigs(env);
  const withheld = new Set([SIMPLE_KEY_SECRET]);
  if (!account.operatorKeys) for (const name of apiKeySecrets(configs)) withheld.add(name);
  return createProviderRegistry(configs, providerEnv(env, apiKeys, withheld));
}

export function chatSettingsFor(env: AppEnv, account: AccountContext): ChatSettings {
  if (account.mode === 'simple') return simpleChatSettings(env);
  return {
    ...DEFAULT_CHAT_SETTINGS,
    summaryProviderId: env.SUMMARY_PROVIDER_ID?.trim() || null,
    summaryModel: env.SUMMARY_MODEL?.trim() || null,
    autoTitle: env.AUTO_TITLE !== 'false',
  };
}

/**
 * Built-in system prompt of an account's new trees, used when the request
 * names none and the account has none saved (GET/PATCH /api/settings). Both
 * modes share DEFAULT_SYSTEM_PROMPT; only Learn honours the operator's
 * SIMPLE_SYSTEM_PROMPT, since power users can set their own.
 */
export function defaultSystemPromptFor(env: AppEnv, account: AccountContext): string {
  return account.mode === 'simple' ? simpleSystemPrompt(env) : DEFAULT_SYSTEM_PROMPT;
}

export interface ChatServiceOptions {
  /** Bring-your-own-key overrides (ignored on paid credit, see registryFor). */
  apiKeys?: UserApiKeys;
  /** Where the usage meter parks its background work (paid credit). */
  defer?: Defer;
}

/** Last resort when a caller has no `waitUntil`: the work still runs, failures are logged. */
const detach: Defer = (p) => {
  p.catch((err: unknown) => console.error('Deferred usage work failed', err));
};

/**
 * Every provider call on paid credit is metered: the registry is wrapped
 * so each `stream()` records a `usage_events` row (billing/meter.ts). The
 * meter is built on the first `get`, so routes that never generate (listing
 * trees, reading providers) don't pay for it.
 */
function meteredLazily(
  inner: ProviderRegistry,
  env: AppEnv,
  account: AccountContext,
  defer: Defer,
): ProviderRegistry {
  let metered: ProviderRegistry | null = null;
  return {
    get: (providerId) => {
      metered ??= meteredRegistry(inner, createUsageMeter(env, account, defer));
      return metered.get(providerId);
    },
    list: () => inner.list(),
    defaultProviderId: () => inner.defaultProviderId(),
  };
}

/** The only place Worker env is translated into a ChatService for an account. */
export function chatService(
  env: AppEnv,
  account: AccountContext,
  opts: ChatServiceOptions = {},
): ChatService {
  const registry = registryFor(env, account, opts.apiKeys);
  return new ChatService({
    repos: createD1Repositories(env.DB),
    accountId: account.id,
    providers: isMetered(account)
      ? meteredLazily(registry, env, account, opts.defer ?? detach)
      : registry,
    settings: chatSettingsFor(env, account),
    defaultSystemPrompt: defaultSystemPromptFor(env, account),
  });
}

export function shareService(env: AppEnv, requestUrl: string, accountId?: string): ShareService {
  const base = env.PUBLIC_BASE_URL?.trim() || new URL(requestUrl).origin;
  return new ShareService({
    repos: createD1Repositories(env.DB),
    publicBaseUrl: base,
    ...(accountId ? { accountId } : {}),
  });
}
