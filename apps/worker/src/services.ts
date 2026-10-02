import { ChatService, DEFAULT_CHAT_SETTINGS, ShareService, type ChatSettings } from '@tangent/core';
import {
  createProviderRegistry,
  DEFAULT_PROVIDER_CONFIGS,
  parseProviderConfigs,
  type ProviderEnv,
} from '@tangent/providers';
import type { ProviderConfig, ProviderRegistry } from '@tangent/shared';
import { createUsageMeter, meteredRegistry } from './billing/meter.js';
import { createD1Repositories } from './db/d1-repositories.js';
import type { AccountContext, AppEnv } from './env.js';
import { simpleChatSettings, simpleProviderConfig } from './simple-mode.js';

/** Provider id → user-supplied API key (bring-your-own-key, see byok/keys.ts). */
export type UserApiKeys = Readonly<Record<string, string>>;

/** Keeps background work alive past the response (`waitUntil` of the Worker or the Durable Object). */
export type Defer = (p: Promise<unknown>) => void;

/** Power-mode provider configs (the PROVIDERS var, or the built-in defaults). */
export function providerConfigs(env: AppEnv): ProviderConfig[] {
  return env.PROVIDERS?.trim() ? parseProviderConfigs(env.PROVIDERS) : DEFAULT_PROVIDER_CONFIGS;
}

/** Secrets and vars share the env object; providers look up only the names they are configured with. */
export function providerEnv(env: AppEnv, apiKeys?: UserApiKeys): ProviderEnv {
  const secrets: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    // The cookie-sealing secret is never a provider credential.
    if (typeof v === 'string' && k !== 'KEY_ENCRYPTION_SECRET') secrets[k] = v;
  }
  return apiKeys ? { secrets, apiKeys } : { secrets };
}

/**
 * The providers an account may use. Simple accounts get only the server-side
 * `tangent` provider (simple-mode.ts) and never user keys; power accounts get
 * the configured providers, with `apiKeys` overriding server secrets.
 */
export function registryFor(
  env: AppEnv,
  account: AccountContext,
  apiKeys?: UserApiKeys,
): ProviderRegistry {
  if (account.mode === 'simple')
    return createProviderRegistry([simpleProviderConfig(env)], providerEnv(env));
  return createProviderRegistry(providerConfigs(env), providerEnv(env, apiKeys));
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

export interface ChatServiceOptions {
  /** Bring-your-own-key overrides (power accounts only; ignored for simple). */
  apiKeys?: UserApiKeys;
  /** Where the usage meter parks its background work (simple accounts). */
  defer?: Defer;
}

/** Last resort when a caller has no `waitUntil`: the work still runs, failures are logged. */
const detach: Defer = (p) => {
  p.catch((err: unknown) => console.error('Deferred usage work failed', err));
};

/**
 * Every provider call of a simple account is metered: the registry is wrapped
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
    providers:
      account.mode === 'simple'
        ? meteredLazily(registry, env, account, opts.defer ?? detach)
        : registry,
    settings: chatSettingsFor(env, account),
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
