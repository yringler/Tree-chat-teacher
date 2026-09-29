import { ChatService, DEFAULT_CHAT_SETTINGS, ShareService, type ChatSettings } from '@tangent/core';
import {
  createProviderRegistry,
  DEFAULT_PROVIDER_CONFIGS,
  parseProviderConfigs,
} from '@tangent/providers';
import type { ProviderRegistry } from '@tangent/shared';
import { createD1Repositories } from './db/d1-repositories.js';
import type { AppEnv } from './env.js';

/** The only place Worker env is translated into runtime-agnostic services. */
export function providerRegistry(env: AppEnv): ProviderRegistry {
  const configs = env.PROVIDERS?.trim() ? parseProviderConfigs(env.PROVIDERS) : DEFAULT_PROVIDER_CONFIGS;
  // Secrets and vars share the env object; providers look up only the names they are configured with.
  const secrets: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') secrets[k] = v;
  return createProviderRegistry(configs, { secrets });
}

export function chatSettings(env: AppEnv): ChatSettings {
  return {
    ...DEFAULT_CHAT_SETTINGS,
    summaryProviderId: env.SUMMARY_PROVIDER_ID?.trim() || null,
    summaryModel: env.SUMMARY_MODEL?.trim() || null,
    autoTitle: env.AUTO_TITLE !== 'false',
  };
}

/** `accountId` defaults to the built-in account (used by the Durable Object, which works by branch/node id). */
export function chatService(env: AppEnv, accountId?: string): ChatService {
  return new ChatService({
    repos: createD1Repositories(env.DB),
    ...(accountId ? { accountId } : {}),
    providers: providerRegistry(env),
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
