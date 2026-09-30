import { ChatService, DEFAULT_CHAT_SETTINGS, ShareService, type ChatSettings } from '@tangent/core';
import {
  createProviderRegistry,
  DEFAULT_PROVIDER_CONFIGS,
  parseProviderConfigs,
  type ProviderEnv,
} from '@tangent/providers';
import type { ProviderConfig, ProviderRegistry } from '@tangent/shared';
import { createD1Repositories } from './db/d1-repositories.js';
import type { AppEnv } from './env.js';

/** Provider id → user-supplied API key (bring-your-own-key, see byok/keys.ts). */
export type UserApiKeys = Readonly<Record<string, string>>;

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

/** The only place Worker env is translated into runtime-agnostic services. */
export function providerRegistry(env: AppEnv, apiKeys?: UserApiKeys): ProviderRegistry {
  return createProviderRegistry(providerConfigs(env), providerEnv(env, apiKeys));
}

export function chatSettings(env: AppEnv): ChatSettings {
  return {
    ...DEFAULT_CHAT_SETTINGS,
    summaryProviderId: env.SUMMARY_PROVIDER_ID?.trim() || null,
    summaryModel: env.SUMMARY_MODEL?.trim() || null,
    autoTitle: env.AUTO_TITLE !== 'false',
  };
}

/**
 * `accountId` defaults to the built-in account (used by the Durable Object,
 * which works by branch/node id). `apiKeys` override server secrets per
 * provider for everything this service generates (replies, summaries, titles).
 */
export function chatService(env: AppEnv, accountId?: string, apiKeys?: UserApiKeys): ChatService {
  return new ChatService({
    repos: createD1Repositories(env.DB),
    ...(accountId ? { accountId } : {}),
    providers: providerRegistry(env, apiKeys),
    settings: chatSettings(env),
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
