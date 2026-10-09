// Settling usage whose cost the stream didn't report (aborted, truncated or
// evicted generations): OpenRouter's generation endpoint, with retries right
// after the stream and a cron backstop.
import { costUsdToNanos } from '@tangent/shared';
import { fetchOpenRouterGeneration, type GenerationCost } from '@tangent/providers';
import { appConfig } from '../config.js';
import type { AppEnv } from '../env.js';
import { expirePoolReservations, type ExpiryResult } from '../pool/expiry.js';
import { poolBank } from '../pool/ids.js';
import { POOL_EXPIRE_BATCH, POOL_GIVE_UP_MS, POOL_RESERVATION_TTL_MS } from '../pool/params.js';
import { simpleApiKey } from '../simple-mode.js';
import { markUnresolved, settleUsage } from './usage-store.js';
import { logEvent } from '../log.js';

/** Backoff after a stream ends without a cost: OpenRouter 404s for a few seconds. */
export const RECONCILE_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000, 30_000];

const MINUTE = 60_000;
/** The cron leaves younger rows to the in-flight stream / its deferred reconcile. */
export const CRON_MIN_AGE_MS = 2 * MINUTE;
/** A row that never got a generation id never reached OpenRouter: settle at 0. */
export const CRON_NO_ID_AGE_MS = 10 * MINUTE;
/** Give up (charge 0, `unresolved`, logged) after this long. */
export const CRON_GIVE_UP_AGE_MS = 24 * 60 * MINUTE;
const CRON_BATCH = 200;
/** Pools the cron expires reservations for, at most, per run. */
const CRON_POOL_LIMIT = 10;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

async function lookup(
  generationId: string,
  key: string,
  fetchImpl?: typeof fetch,
): Promise<GenerationCost | null> {
  try {
    return await fetchOpenRouterGeneration(generationId, key, fetchImpl);
  } catch (e) {
    logEvent('warn', 'generation_lookup_failed', { generationId, error: e });
    return null;
  }
}

/**
 * At least one search when OpenRouter reports search results for the
 * generation (it reports results, not searches); null when unknown.
 */
function searchesFrom(cost: GenerationCost): number | null {
  return cost.numSearchResults !== null && cost.numSearchResults > 0 ? 1 : null;
}

export interface ReconcileTarget {
  usageId: string;
  markupBps: number;
  feeBps: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  webSearches?: number | null;
}

/**
 * Right after a stream ended without a cost: polls the generation with
 * backoff, then settles. Resolves true once settled (or already settled
 * elsewhere); false leaves the row pending for the cron. Never rejects.
 */
export async function reconcileGeneration(
  env: AppEnv,
  target: ReconcileTarget,
  generationId: string,
  options: { delaysMs?: readonly number[]; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const key = simpleApiKey(env);
  if (!key) {
    logEvent('warn', 'reconcile_no_key', { usageId: target.usageId });
    return false;
  }
  let cost: GenerationCost | null = null;
  for (const delay of options.delaysMs ?? RECONCILE_RETRY_DELAYS_MS) {
    await sleep(delay);
    cost ??= await lookup(generationId, key, options.fetchImpl);
    if (!cost) continue;
    try {
      await settleUsage(env.DB, target.usageId, {
        costNanos: costUsdToNanos(cost.costUsd),
        markupBps: target.markupBps,
        feeBps: target.feeBps,
        reason: 'generation',
        inputTokens: target.inputTokens ?? cost.inputTokens,
        outputTokens: target.outputTokens ?? cost.outputTokens,
        webSearches: target.webSearches ?? searchesFrom(cost),
      });
      return true;
    } catch (e) {
      logEvent('error', 'usage_settle_failed', { usageId: target.usageId, error: e });
    }
  }
  return false;
}

interface PendingRow {
  id: string;
  generation_id: string | null;
  markup_bps: number;
  fee_bps: number;
  created_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
}

/**
 * Cron backstop (`scheduled`, every 10 minutes) for pending personal usage
 * rows older than 2 minutes: with a generation id → settle from OpenRouter's
 * reported cost; without one after 10 minutes → settle at 0; still pending
 * after 24 hours → `unresolved` at 0, logged for manual review. Open pool
 * rows are filtered out in SQL (a backlog of them never starves these) and
 * expired by `reconcilePoolUsage` instead.
 */
export async function reconcilePendingUsage(
  env: AppEnv,
  now: Date = new Date(),
): Promise<{ settled: number; unresolved: number }> {
  const nowMs = now.getTime();
  const { results } = await env.DB.prepare(
    `SELECT id, generation_id, markup_bps, fee_bps, created_at, input_tokens, output_tokens
     FROM usage_events WHERE status = 'pending' AND funding <> 'pool' AND created_at < ?
     ORDER BY created_at LIMIT ?`,
  )
    .bind(new Date(nowMs - CRON_MIN_AGE_MS).toISOString(), CRON_BATCH)
    .all<PendingRow>();

  const key = simpleApiKey(env);
  let settled = 0;
  let unresolved = 0;
  for (const row of results) {
    const age = nowMs - Date.parse(row.created_at);
    try {
      if (row.generation_id) {
        const cost = key ? await lookup(row.generation_id, key) : null;
        if (cost) {
          const { changed } = await settleUsage(env.DB, row.id, {
            costNanos: costUsdToNanos(cost.costUsd),
            markupBps: row.markup_bps,
            feeBps: row.fee_bps,
            reason: 'generation',
            inputTokens: row.input_tokens ?? cost.inputTokens,
            outputTokens: row.output_tokens ?? cost.outputTokens,
            webSearches: searchesFrom(cost),
            now,
          });
          if (changed) settled++;
        } else if (age > CRON_GIVE_UP_AGE_MS) {
          if (await markUnresolved(env.DB, row.id, now)) {
            unresolved++;
            logEvent('error', 'usage_unresolved', {
              usageId: row.id,
              generationId: row.generation_id,
            });
          }
        }
      } else if (age > CRON_NO_ID_AGE_MS) {
        const zero = {
          costNanos: 0,
          markupBps: row.markup_bps,
          feeBps: row.fee_bps,
          reason: 'released' as const,
          now,
        };
        if ((await settleUsage(env.DB, row.id, zero)).changed) settled++;
      }
    } catch (e) {
      logEvent('error', 'usage_reconcile_failed', { usageId: row.id, error: e });
    }
  }
  return { settled, unresolved };
}

/**
 * Cron backstop for the open pool: expires stale reservations of every
 * pool account with any (in case a PoolBank alarm was lost), then advances
 * and verifies the configured pool's balance checkpoint (its id from
 * `appConfig(env)`).
 */
export async function reconcilePoolUsage(
  env: AppEnv,
  now: Date = new Date(),
): Promise<Record<string, ExpiryResult>> {
  const pool = appConfig(env).pool;
  const options = {
    ttlMs: POOL_RESERVATION_TTL_MS,
    giveUpMs: POOL_GIVE_UP_MS,
    batch: POOL_EXPIRE_BATCH,
  };
  const out: Record<string, ExpiryResult> = {};
  try {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT account_id FROM usage_events
       WHERE status = 'pending' AND funding = 'pool' AND created_at < ? LIMIT ?`,
    )
      .bind(new Date(now.getTime() - options.ttlMs).toISOString(), CRON_POOL_LIMIT)
      .all<{ account_id: string }>();
    for (const { account_id: poolId } of results) {
      try {
        out[poolId] = await expirePoolReservations(env, poolId, now, options);
      } catch (e) {
        logEvent('error', 'pool_expiry_failed', { poolId, error: e });
      }
    }
  } catch (e) {
    logEvent('error', 'pool_expiry_failed', { error: e });
  }
  if (appConfig(env).flags.poolEnabled) {
    try {
      await poolBank(env, pool.accountId).maintain({
        poolId: pool.accountId,
        giveUpMs: POOL_GIVE_UP_MS,
        now: now.getTime(),
      });
    } catch (e) {
      logEvent('error', 'pool_maintenance_failed', { error: e });
    }
  }
  return out;
}
