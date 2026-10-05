// The pool meter (docs/pool/PLAN.md §S6): what `GET /api/pool/status`, the
// landing page and the apps show about the community pool. Aggregates only:
// the balance, the sessions it covers and this week's counts, never a user.
import type { PoolMeResponse, PoolStatusResponse } from '@tangent/shared';
import { balanceStatement, getBalance, readBalance, type BalanceRow } from '../billing/ledger.js';
import { topUpsEnabled } from '../billing/service.js';
import { appConfig } from '../config.js';
import type { AccountContext, AppEnv } from '../env.js';
import { poolAvailable } from '../services.js';
import { getCached, putCached } from '../share/cache.js';
import { simpleProviderConfig } from '../simple-mode.js';
import { consentVersion } from './consent.js';
import { poolModel } from './params.js';
import { dayResetAt, dayStart, userDayUsageStatement, type DayRow } from './pool-bank.js';
import { isSupporter } from './supporter.js';

/** How long the meter is cached at the edge (`caches.default`) and by browsers. */
export const POOL_STATUS_MAX_AGE_S = 60;

/** Monday 00:00 UTC of `now`'s ISO week. */
export function weekStart(now: Date): Date {
  const day = dayStart(now);
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * 24 * 60 * 60_000);
}

/** The pool model and its label in the simple provider's list (`Simple`), else its id. */
function poolModelInfo(env: AppEnv): { id: string; label: string } {
  const id = poolModel(env);
  const label = simpleProviderConfig(env).models.find((m) => m.id === id)?.label ?? id;
  return { id, label };
}

/**
 * The pool meter, read from D1. "Exchanges funded" are pool replies settled
 * at a charge above 0 since Monday 00:00 UTC (released and free ones never
 * reached the model, or cost nothing); "learners" the distinct users of those.
 */
export async function poolStatus(env: AppEnv, now = new Date()): Promise<PoolStatusResponse> {
  const config = appConfig(env);
  const pool = config.pool;
  const week = weekStart(now).toISOString();
  const base: PoolStatusResponse = {
    enabled: poolAvailable(env),
    fundingOpen: topUpsEnabled(env),
    availableMicros: 0,
    sessionsRemaining: 0,
    model: poolModelInfo(env),
    week: { start: week, exchanges: 0, learners: 0 },
    markupBps: pool.markupBps,
    minPurchaseCents: pool.minPurchaseCents,
  };
  if (!base.enabled) return base;
  const [balanceRes, countsRes] = await env.DB.batch<Record<string, unknown>>([
    balanceStatement(env.DB, pool.accountId),
    env.DB.prepare(
      `SELECT COUNT(*) AS exchanges, COUNT(DISTINCT user_id) AS learners FROM usage_events
       WHERE account_id = ? AND purpose = 'reply' AND status = 'settled'
         AND charge_micros > 0 AND created_at >= ?`,
    ).bind(pool.accountId, week),
  ]);
  const balance = readBalance(balanceRes!.results[0] as BalanceRow | undefined);
  const counts = countsRes!.results[0] as { exchanges?: number; learners?: number } | undefined;
  const available = Math.max(0, balance.balanceMicros - balance.heldMicros);
  return {
    ...base,
    availableMicros: available,
    sessionsRemaining: Math.floor(available / pool.sessionEstimateMicros),
    week: {
      start: week,
      exchanges: Number(counts?.exchanges ?? 0),
      learners: Number(counts?.learners ?? 0),
    },
  };
}

/** The edge cache key of `poolId`'s meter (share/cache.ts helpers; never a public URL). */
function statusCacheKey(poolId: string): Request {
  return new Request(`https://pool-cache.internal/status/${encodeURIComponent(poolId)}`);
}

/**
 * `poolStatus` through the edge cache for `POOL_STATUS_MAX_AGE_S`, keyed on
 * the pool's account id. Both the public route and the landing page read it,
 * so a busy landing page costs D1 a couple of reads a minute per colo.
 */
export async function cachedPoolStatus(
  env: AppEnv,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<PoolStatusResponse> {
  const key = statusCacheKey(appConfig(env).pool.accountId);
  const hit = await getCached(key);
  if (hit) return (await hit.json()) as PoolStatusResponse;
  const status = await poolStatus(env);
  putCached(ctx, key, Response.json(status), POOL_STATUS_MAX_AGE_S);
  return status;
}

interface PoolAccountRow {
  pool_suspended: number;
  pool_verified_at: string | null;
  identity_suspended: number | null;
}

/** `GET /api/pool/me`: the caller's standing with the pool today. */
export async function poolMe(
  env: AppEnv,
  account: AccountContext,
  now = new Date(),
): Promise<PoolMeResponse> {
  const pool = appConfig(env).pool;
  const userId = account.userId;
  const day = dayStart(now).toISOString();
  const [personal, row, usage, supporter, consent] = await Promise.all([
    getBalance(env.DB, account.billingAccountId),
    userId
      ? env.DB.prepare(
          `SELECT u.pool_suspended, u.pool_verified_at,
             (SELECT suspended FROM pool_identities WHERE identity = u.pool_identity) AS identity_suspended
             FROM auth_users u WHERE u.id = ?`,
        )
          .bind(userId)
          .first<PoolAccountRow>()
      : null,
    userId ? userDayUsageStatement(env.DB, pool.accountId, userId, day).first<DayRow>() : null,
    userId ? isSupporter(env.DB, userId, now, pool.caps.supporter.windowMonths) : false,
    userId ? consentVersion(env.DB, userId) : null,
  ]);
  const caps = supporter ? pool.caps.supporter : pool.caps.free;
  return {
    available: poolAvailable(env) && userId !== null,
    verified: !!row?.pool_verified_at,
    supporter,
    suspended: !!row?.pool_suspended || !!row?.identity_suspended,
    caps: {
      requestsPerDay: caps.requestsPerDay,
      spendMicrosPerDay: caps.spendMicrosPerDay,
      usedRequests: Number(usage?.requests ?? 0),
      usedSpendMicros: Number(usage?.spend ?? 0),
      resetAt: dayResetAt(now),
    },
    personalAvailableMicros: personal.balanceMicros - personal.heldMicros,
    consentVersion: consent,
    currentNoticeVersion: pool.noticeVersion,
  };
}
