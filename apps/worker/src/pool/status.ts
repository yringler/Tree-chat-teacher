// The pool meter: what `GET /api/pool/status`, the
// landing page and the apps show about the open pool. Aggregates only:
// the balance and the sessions it covers, never a user.
import {
  isReasoningModel,
  type PoolMeResponse,
  type PoolModelInfo,
  type PoolStatusResponse,
} from '@tangent/shared';
import { getBalance } from '../billing/ledger.js';
import { appConfig } from '../config.js';
import type { SqlRow } from '../db/rows.js';
import type { authUsers, poolIdentities } from '../db/schema.js';
import type { AccountContext, AppEnv } from '../env.js';
import { poolAvailable } from '../availability.js';
import { getCached, putCached } from '../share/cache.js';
import {
  SIMPLE_MAX_OUTPUT_TOKENS,
  SIMPLE_RESERVED_OUTPUT_TOKENS,
  simpleProviderConfig,
} from '../simple-mode.js';
import { POOL_SESSION_ESTIMATE_MICROS, poolModel, poolPriceProblem } from './params.js';
import { dayResetAt, dayStart, userDayUsageStatement, type DayRow } from './day-usage.js';

/** How long the meter is cached at the edge (`caches.default`) and by browsers. */
export const POOL_STATUS_MAX_AGE_S = 60;

/**
 * The pool model, Normal's, with its label in the simple provider's list,
 * and whether the pool's reply cap (`POOL_MAX_OUTPUT_TOKENS`, which replaces
 * Normal's on the pool) is below or above a reply's on Normal (Normal's cap,
 * within the default for a reasoning or a plain model). The pool asks it as
 * Normal does otherwise.
 */
export function poolModelInfo(env: AppEnv): PoolModelInfo {
  const id = poolModel(env);
  const listed = simpleProviderConfig(env).models.find((m) => m.id === id);
  const info: PoolModelInfo = { id, label: listed?.label ?? id };
  const reasoning = listed?.reasoning ?? isReasoningModel(id);
  const tierReply = Math.min(
    listed?.maxOutputTokens ?? Infinity,
    reasoning ? SIMPLE_MAX_OUTPUT_TOKENS : SIMPLE_RESERVED_OUTPUT_TOKENS,
  );
  const poolReply = appConfig(env).pool.maxOutputTokens;
  if (poolReply !== tierReply) info.replies = poolReply < tierReply ? 'shorter' : 'longer';
  return info;
}

/**
 * Whether the pool can serve a reply now: `poolAvailable`, and its model's
 * live price (`poolPriceProblem`) leaves a reply's ceiling hold within the
 * daily caps. What the meter and `/api/pool/me` report.
 */
export async function poolUsable(env: AppEnv): Promise<boolean> {
  return poolAvailable(env) && (await poolPriceProblem(env)) === null;
}

/** The pool meter, read from D1. */
export async function poolStatus(env: AppEnv): Promise<PoolStatusResponse> {
  const config = appConfig(env);
  const pool = config.pool;
  const base: PoolStatusResponse = {
    enabled: await poolUsable(env),
    availableMicros: 0,
    sessionsRemaining: 0,
    model: poolModelInfo(env),
  };
  if (!base.enabled) return base;
  const balance = await getBalance(env.DB, pool.accountId);
  const available = Math.max(0, balance.balanceMicros - balance.heldMicros);
  return {
    ...base,
    availableMicros: available,
    sessionsRemaining: Math.floor(available / POOL_SESSION_ESTIMATE_MICROS),
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

type PoolAccountRow = Pick<SqlRow<typeof authUsers>, 'pool_suspended' | 'pool_verified_at'> & {
  identity_suspended: SqlRow<typeof poolIdentities>['suspended'] | null;
};

/** `GET /api/pool/me`: the caller's standing with the pool today. */
export async function poolMe(
  env: AppEnv,
  account: AccountContext,
  now = new Date(),
): Promise<PoolMeResponse> {
  const pool = appConfig(env).pool;
  const userId = account.userId;
  const day = dayStart(now).toISOString();
  const [personal, row, usage, usable] = await Promise.all([
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
    poolUsable(env),
  ]);
  // The same caps for everyone, member or not.
  const caps = pool.caps.user;
  return {
    available: usable && userId !== null,
    verified: !!row?.pool_verified_at,
    suspended: !!row?.pool_suspended || !!row?.identity_suspended,
    caps: {
      requestsPerDay: caps.requestsPerDay,
      spendMicrosPerDay: caps.spendMicrosPerDay,
      usedRequests: Number(usage?.requests ?? 0),
      usedSpendMicros: Number(usage?.spend ?? 0),
      resetAt: dayResetAt(now),
    },
    personalAvailableMicros: personal.balanceMicros - personal.heldMicros,
  };
}
