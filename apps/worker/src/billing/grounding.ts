// Grounding config and the daily cap on automatic web searches
// (docs/DECISIONS.md § Grounding). Searches are billed like any other cost:
// OpenRouter folds their fee into the generation's reported cost.
import {
  DEFAULT_GROUNDING_SETTINGS,
  GROUNDING_POLICIES,
  type GroundingPolicy,
  type GroundingSettings,
} from '@tangent/core';
import type { ProviderRoute } from '@tangent/shared';
import { isMetered, type AccountContext, type AppEnv } from '../env.js';
import { intVar } from '../config.js';

export const DEFAULT_GROUNDING_AUTO_DAILY_CAP = 40;
/** OpenRouter accepts 1–25 results per search. */
const MAX_RESULTS_LIMIT = 25;

function groundingPolicy(env: AppEnv): GroundingPolicy {
  const raw = env.GROUNDING?.trim();
  if (!raw) return 'auto';
  return (GROUNDING_POLICIES as readonly string[]).includes(raw) ? (raw as GroundingPolicy) : 'off';
}

/**
 * Grounding settings from the `GROUNDING*` vars. An unknown `GROUNDING` value
 * turns grounding off (fail cheap). Learn ignores the per-branch setting.
 */
export function groundingSettings(env: AppEnv, mode: AccountContext['mode']): GroundingSettings {
  const maxResults = intVar(env.GROUNDING_MAX_RESULTS, DEFAULT_GROUNDING_SETTINGS.maxResults);
  return {
    ...DEFAULT_GROUNDING_SETTINGS,
    policy: groundingPolicy(env),
    maxResults: Math.min(MAX_RESULTS_LIMIT, Math.max(1, maxResults)),
    engine: env.GROUNDING_ENGINE?.trim() || DEFAULT_GROUNDING_SETTINGS.engine,
    ignoreBranchSetting: mode === 'simple',
  };
}

/** Automatic searches per user per UTC day on credit; 0 = no cap. */
export function groundingDailyCap(env: AppEnv): number {
  return intVar(env.GROUNDING_AUTO_DAILY_CAP, DEFAULT_GROUNDING_AUTO_DAILY_CAP);
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
