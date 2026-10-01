// Settling usage whose cost the stream didn't report (aborted, truncated or
// evicted generations): OpenRouter's generation endpoint, with retries right
// after the stream and a cron backstop (PLAN §2.4).
import { fetchOpenRouterGeneration, type GenerationCost } from '@tangent/providers';
import type { AppEnv } from '../env.js';
import { costUsdToNanos } from './pricing.js';
import { markUnresolved, settleUsage } from './usage-store.js';

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

/**
 * The OpenRouter key simple mode spends: the secret named by
 * `SIMPLE_PROVIDER.apiKeySecret` when set, else `OPENROUTER_SIMPLE_API_KEY`.
 */
export function simpleApiKey(env: AppEnv): string | null {
  let secretName = 'OPENROUTER_SIMPLE_API_KEY';
  const override = env.SIMPLE_PROVIDER?.trim();
  if (override) {
    try {
      const parsed: unknown = JSON.parse(override);
      const config: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
      if (typeof config === 'object' && config !== null) {
        const name = (config as Record<string, unknown>)['apiKeySecret'];
        if (typeof name === 'string' && name) secretName = name;
      }
    } catch {
      // Invalid SIMPLE_PROVIDER fails loudly where the registry is built; keep the default here.
    }
  }
  const value = (env as unknown as Record<string, unknown>)[secretName];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

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
    console.warn(
      'OpenRouter generation lookup failed',
      generationId,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

export interface ReconcileTarget {
  usageId: string;
  markupBps: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
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
    console.warn(
      'No OpenRouter key for usage reconciliation; leaving usage pending',
      target.usageId,
    );
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
        inputTokens: target.inputTokens ?? cost.inputTokens,
        outputTokens: target.outputTokens ?? cost.outputTokens,
      });
      return true;
    } catch (e) {
      console.error('Usage settle failed; retrying', target.usageId, e);
    }
  }
  return false;
}

interface PendingRow {
  id: string;
  generation_id: string | null;
  markup_bps: number;
  created_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
}

/**
 * Cron backstop (`scheduled`, every 10 minutes) for pending usage rows older
 * than 2 minutes: with a generation id → settle from OpenRouter's reported
 * cost; without one after 10 minutes → settle at 0; still pending after
 * 24 hours → `unresolved` at 0, logged for manual review.
 */
export async function reconcilePendingUsage(
  env: AppEnv,
  now: Date = new Date(),
): Promise<{ settled: number; unresolved: number }> {
  const nowMs = now.getTime();
  const { results } = await env.DB.prepare(
    `SELECT id, generation_id, markup_bps, created_at, input_tokens, output_tokens
     FROM usage_events WHERE status = 'pending' AND created_at < ?
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
          const changed = await settleUsage(env.DB, row.id, {
            costNanos: costUsdToNanos(cost.costUsd),
            markupBps: row.markup_bps,
            inputTokens: row.input_tokens ?? cost.inputTokens,
            outputTokens: row.output_tokens ?? cost.outputTokens,
            now,
          });
          if (changed) settled++;
        } else if (age > CRON_GIVE_UP_AGE_MS) {
          if (await markUnresolved(env.DB, row.id, now)) {
            unresolved++;
            console.error('Usage unresolved after 24 h; charged 0, review manually', {
              usageId: row.id,
              generationId: row.generation_id,
            });
          }
        }
      } else if (age > CRON_NO_ID_AGE_MS) {
        if (await settleUsage(env.DB, row.id, { costNanos: 0, markupBps: row.markup_bps, now }))
          settled++;
      }
    } catch (e) {
      console.error('Usage reconciliation failed for row', row.id, e);
    }
  }
  return { settled, unresolved };
}
