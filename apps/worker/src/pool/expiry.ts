// Expiry of stale open pool reservations: run
// by PoolBank's alarm and, as a backstop, by the cron. A reservation older
// than its TTL belongs to a request that crashed or was evicted; settling it
// only raises the pool's available balance, so this takes no lock and never
// blocks a reservation.
import { fetchOpenRouterGeneration, type GenerationCost } from '@tangent/providers';
import { settleUsage } from '../billing/usage-store.js';
import type { SqlRow } from '../db/rows.js';
import type { usageEvents } from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { simpleApiKey } from '../simple-mode.js';
import type { PoolExpiryParams } from './pool-bank.js';
import { poolSettlement } from './settle-policy.js';
import { logEvent } from '../log.js';

/** One generation lookup per expired row, with this timeout: an alarm never waits on a slow upstream for long. */
export const EXPIRY_LOOKUP_TIMEOUT_MS = 5_000;
/** How soon the alarm comes back for rows whose cost is still unknown. */
const EXPIRY_RETRY_MS = 60_000;
/** When an expiry pass left more expired rows than its batch, the alarm comes back after this. */
const REARM_SOON_MS = 1_000;

export interface ExpiryOptions {
  /** Reservations older than this are expired. */
  ttlMs: number;
  /** A dispatched call with a generation id is charged its hold once this old. */
  giveUpMs: number;
  /** Rows settled per call; the caller comes back for the rest. */
  batch: number;
  /** Test seam for the generation lookup. */
  fetchImpl?: typeof fetch;
}

export interface ExpiryResult {
  /** Released at 0 (never dispatched). */
  released: number;
  /** Settled from a lookup, or at the full hold. */
  charged: number;
  /** Left pending: a lookup failed before the give-up age. */
  deferred: number;
  /** More expired rows than `batch` were waiting: run again right away. */
  more: boolean;
}

type ExpiredRow = Pick<
  SqlRow<typeof usageEvents>,
  'id' | 'generation_id' | 'dispatched_at' | 'fee_bps' | 'created_at'
> & { lookup_only: number };

function timedFetch(fetchImpl: typeof fetch | undefined): typeof fetch {
  const inner = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    inner(input, {
      ...init,
      signal: AbortSignal.timeout(EXPIRY_LOOKUP_TIMEOUT_MS),
    })) as typeof fetch;
}

async function lookupOnce(
  env: AppEnv,
  generationId: string,
  fetchImpl: typeof fetch | undefined,
): Promise<GenerationCost | null> {
  const key = simpleApiKey(env);
  if (!key) return null;
  try {
    return await fetchOpenRouterGeneration(generationId, key, timedFetch(fetchImpl));
  } catch (e) {
    logEvent('warn', 'generation_lookup_failed', { generationId, source: 'pool_expiry', error: e });
    return null;
  }
}

async function isPending(env: AppEnv, usageId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS pending FROM usage_events WHERE id = ? AND status = 'pending'",
  )
    .bind(usageId)
    .first<{ pending: number }>();
  return row !== null;
}

/**
 * Settles up to `batch` pending reservations of `poolId` older than the TTL,
 * in parallel: never dispatched → released at 0; a generation id → one lookup
 * (its cost, or the full hold once past `giveUpMs`, else left for later);
 * dispatched without one → the full hold. A release only applies while the
 * row is still undispatched (checked in the UPDATE itself). Rows that need no lookup go first,
 * so rows waiting on a lookup never starve the others.
 */
export async function expirePoolReservations(
  env: AppEnv,
  poolId: string,
  now: Date,
  options: ExpiryOptions,
): Promise<ExpiryResult> {
  const nowMs = now.getTime();
  const ttlCut = new Date(nowMs - options.ttlMs).toISOString();
  const giveUpCut = new Date(nowMs - options.giveUpMs).toISOString();
  const batch = Math.max(1, Math.floor(options.batch));
  const { results } = await env.DB.prepare(
    `SELECT id, generation_id, dispatched_at, fee_bps, created_at,
            (generation_id IS NOT NULL AND dispatched_at IS NOT NULL AND created_at >= ?3) AS lookup_only
     FROM usage_events
     WHERE account_id = ?1 AND status = 'pending' AND funding = 'pool' AND created_at < ?2
     ORDER BY lookup_only, created_at LIMIT ?4`,
  )
    .bind(poolId, ttlCut, giveUpCut, batch + 1)
    .all<ExpiredRow>();

  const rows = results.slice(0, batch);
  const result: ExpiryResult = {
    released: 0,
    charged: 0,
    deferred: 0,
    more: results.length > batch && !results[batch]!.lookup_only,
  };
  await Promise.all(
    rows.map(async (row) => {
      try {
        const cost = row.generation_id
          ? await lookupOnce(env, row.generation_id, options.fetchImpl)
          : null;
        const past = row.created_at < giveUpCut;
        if (row.dispatched_at && row.generation_id && !cost && !past) {
          result.deferred++;
          return;
        }
        const settlement = poolSettlement({
          dispatched: row.dispatched_at !== null,
          generationCostUsd: cost?.costUsd ?? null,
        });
        const { changed } = await settleUsage(env.DB, row.id, {
          costNanos: settlement.costNanos ?? 0,
          // The pool pays the true cost: no markup.
          markupBps: 0,
          feeBps: row.fee_bps,
          reason: settlement.reason,
          chargeHold: settlement.reason === 'hold',
          requireUndispatched: settlement.reason === 'released',
          inputTokens: cost?.inputTokens ?? null,
          outputTokens: cost?.outputTokens ?? null,
          now,
        });
        if (!changed) {
          // Dispatched since the SELECT: the call is upstream now, so it is never
          // released at 0. Its meter settles it; failing that, a later pass does.
          if (settlement.reason === 'released' && (await isPending(env, row.id))) {
            result.deferred++;
          }
          return;
        }
        if (settlement.reason === 'released') result.released++;
        else result.charged++;
        if (settlement.reason === 'hold') {
          logEvent('warn', 'pool_reservation_expired', {
            poolId,
            usageId: row.id,
            reason: 'hold',
          });
        }
      } catch (e) {
        logEvent('error', 'pool_expiry_failed', { usageId: row.id, error: e });
      }
    }),
  );
  return result;
}

/**
 * When the oldest pending reservation of `poolId` expires (ms), or null when
 * none is pending.
 */
export async function nextExpiryAt(
  env: AppEnv,
  poolId: string,
  ttlMs: number,
): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT MIN(created_at) AS oldest FROM usage_events
     WHERE account_id = ? AND status = 'pending' AND funding = 'pool'`,
  )
    .bind(poolId)
    .first<{ oldest: string | null }>();
  return row?.oldest ? Date.parse(row.oldest) + ttlMs : null;
}

/** The expiry parameters PoolBank's alarm runs with: the latest a reservation brought. */
export interface StoredExpiry extends PoolExpiryParams {
  poolId: string;
}

/** What PoolBank's `storage` holds for its alarm, or null before its first reservation. */
export async function storedExpiry(storage: DurableObjectStorage): Promise<StoredExpiry | null> {
  return (await storage.get<StoredExpiry>('expiry')) ?? null;
}

/** Sets the alarm of `storage` to `at` unless one is already due earlier. */
export async function ensureAlarmBy(storage: DurableObjectStorage, at: number): Promise<void> {
  const current = await storage.getAlarm();
  if (current === null || current > at) await storage.setAlarm(at);
}

/** PoolBank's alarm at `now`: expires stale reservations, then re-arms for the next one. */
export async function runExpiry(
  env: AppEnv,
  storage: DurableObjectStorage,
  expiry: StoredExpiry,
  now: Date,
): Promise<ExpiryResult> {
  const result = await expirePoolReservations(env, expiry.poolId, now, expiry);
  if (result.more) {
    await ensureAlarmBy(storage, Date.now() + REARM_SOON_MS);
  } else {
    const due = await nextExpiryAt(env, expiry.poolId, expiry.ttlMs);
    // Rows already past their TTL here are waiting on a lookup: come back in a minute.
    if (due !== null) await ensureAlarmBy(storage, Math.max(due, Date.now() + EXPIRY_RETRY_MS));
  }
  return result;
}
