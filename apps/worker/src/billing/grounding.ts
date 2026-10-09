// Grounding config and the daily cap on automatic web searches
// (docs/DECISIONS.md § Grounding). Searches are billed like any other cost:
// OpenRouter folds their fee into the generation's reported cost.
import {
  DEFAULT_GROUNDING_SETTINGS,
  type GroundingPolicy,
  type GroundingSettings,
} from '@tangent/core';
import type { ProviderConfig, ProviderRoute } from '@tangent/shared';
import { appConfig } from '../config.js';
import { isMetered, type AccountContext, type AppEnv } from '../env.js';

/** The operator's `GROUNDING` ceiling (default `auto`). */
export function groundingPolicy(env: AppEnv): GroundingPolicy {
  return appConfig(env).grounding.policy;
}

/** Grounding settings from the `GROUNDING*` vars. Learn ignores the per-branch setting. */
export function groundingSettings(env: AppEnv, mode: AccountContext['mode']): GroundingSettings {
  return {
    ...DEFAULT_GROUNDING_SETTINGS,
    policy: appConfig(env).grounding.policy,
    ignoreBranchSetting: mode === 'simple',
  };
}

/**
 * `configs` with `GROUNDING_ENGINE` and `GROUNDING_MAX_RESULTS` as the search
 * options of every openai-compatible config that searches: OpenRouter runs
 * the search on them. They replace a config's own, so every search runs as
 * the vars (and the public pages, `learnOffer`) say.
 */
export function withSearchOptions(env: AppEnv, configs: ProviderConfig[]): ProviderConfig[] {
  const { engine, maxResults } = appConfig(env).grounding;
  return configs.map((config) =>
    config.kind === 'openai-compatible' && config.options?.['webSearch'] === true
      ? {
          ...config,
          options: { ...config.options, webSearchEngine: engine, webSearchMaxResults: maxResults },
        }
      : config,
  );
}

/** Automatic searches per user per UTC day on credit; 0 = no cap. */
export function groundingDailyCap(env: AppEnv): number {
  return appConfig(env).grounding.autoDailyCap;
}

/** Replies that searched since 00:00 UTC on the user's ledger (settled rows carry the count). */
export async function searchesToday(
  env: AppEnv,
  billingAccountId: string,
  now = new Date(),
): Promise<number> {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM usage_events
     WHERE account_id = ?1 AND purpose = 'reply' AND web_searches > 0 AND created_at >= ?2`,
  )
    .bind(billingAccountId, midnight.toISOString())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * `ChatServiceDeps.groundingAllowance`: automatic searches on a metered
 * route (Tangent credit) stop at the daily cap; the user's own keys are theirs
 * to spend. Checks ("Check sources") never consult it.
 */
export function groundingAllowance(
  env: AppEnv,
  account: AccountContext,
): (route: ProviderRoute) => Promise<boolean> {
  return async (route) => {
    if (!isMetered(account, route.funding)) return true;
    const cap = groundingDailyCap(env);
    if (cap === 0) return true;
    return (await searchesToday(env, account.billingAccountId)) < cap;
  };
}
