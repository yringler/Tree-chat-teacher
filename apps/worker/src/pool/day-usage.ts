// The open pool's usage by UTC day, as SQL over `usage_events` and
// `credit_grants`: the daily caps' window, day-to-date usage of a user, a
// network and the whole pool, the pool's balance at 00:00 UTC and what was
// added since (PoolBank's `reserve`), and the overage breaker's sum.
import type { BalanceCheckpoint } from '../billing/ledger.js';

export const DAY_MS = 24 * 60 * 60_000;

/**
 * The overage breaker's sum: the pool's settled overage (charges above their
 * holds) created within `windowMs` before `now`, micro-USD. The breaker is
 * tripped while it exceeds `PoolOverage.maxMicros`; the admin pool panel
 * reads the same sum.
 */
export async function poolOverageMicros(
  db: D1Database,
  poolId: string,
  windowMs: number,
  now: Date,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(overage_micros), 0) AS overage FROM usage_events
       WHERE account_id = ? AND status = 'settled' AND created_at >= ?`,
    )
    .bind(poolId, new Date(now.getTime() - windowMs).toISOString())
    .first<{ overage: number }>();
  return Number(row?.overage ?? 0);
}

export interface DayRow {
  requests: number;
  spend: number;
}

/** A usage row's spend: its hold while pending, its charge once settled. */
const SPEND_EXPR = `(CASE WHEN status = 'pending' THEN hold_micros ELSE COALESCE(charge_micros, 0) END)`;

/** Day-to-date pool usage: replies (released ones excluded) and spend. */
export const DAY_USAGE_COLUMNS = `
  COUNT(CASE WHEN purpose = 'reply' AND COALESCE(settle_reason, '') <> 'released' THEN 1 END) AS requests,
  COALESCE(SUM(${SPEND_EXPR}), 0) AS spend`;

/** 00:00 UTC of `now`'s day: the daily caps' window starts here. */
export function dayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The next 00:00 UTC after `now`: when the daily caps reset. */
export function dayResetAt(now: Date): string {
  return new Date(dayStart(now).getTime() + DAY_MS).toISOString();
}

/**
 * `userId`'s pool usage since `day` (`requests`, `spend`), with what deleted
 * accounts that held their pool identity used that day (pool/identity.ts
 * `releasePoolIdentityStatement`): deleting the account and signing up again
 * doesn't reset the day. Shared by `reserve` and `GET /api/pool/me`.
 */
export function userDayUsageStatement(
  db: D1Database,
  poolId: string,
  userId: string,
  day: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT d.requests + COALESCE(c.deleted_day_requests, 0) AS requests,
         d.spend + COALESCE(c.deleted_day_spend_micros, 0) AS spend
       FROM (SELECT ${DAY_USAGE_COLUMNS} FROM usage_events
             WHERE account_id = ?1 AND user_id = ?2 AND created_at >= ?3) d
       LEFT JOIN (SELECT pi.deleted_day_requests, pi.deleted_day_spend_micros
                  FROM auth_users u JOIN pool_identities pi ON pi.identity = u.pool_identity
                  WHERE u.id = ?2 AND pi.deleted_at >= ?3) c ON 1`,
    )
    .bind(poolId, userId, day);
}

/** The pool's available balance at 00:00 UTC `day` (the checkpoint is never later). */
export function morningBalanceStatement(
  db: D1Database,
  poolId: string,
  checkpoint: BalanceCheckpoint | null,
  day: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ?2
         + (SELECT COALESCE(SUM(amount_micros), 0) FROM credit_grants
            WHERE account_id = ?1 AND created_at >= ?3 AND created_at < ?4)
         - (SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN hold_micros ELSE COALESCE(charge_micros, 0) END), 0)
            FROM usage_events WHERE account_id = ?1 AND created_at >= ?3 AND created_at < ?4) AS available`,
    )
    .bind(poolId, checkpoint?.balanceMicros ?? 0, checkpoint?.at ?? '', day);
}

/** What was added to the pool since 00:00 UTC `day`: today's funding counts toward the ceilings. */
export function addedSinceStatement(
  db: D1Database,
  poolId: string,
  day: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COALESCE(SUM(amount_micros), 0) AS added FROM credit_grants
       WHERE account_id = ?1 AND amount_micros > 0 AND created_at >= ?2`,
    )
    .bind(poolId, day);
}

/** The pool usage of the network `ipKey` since `day` (`requests`, `spend`). */
export function ipDayUsageStatement(
  db: D1Database,
  poolId: string,
  ipKey: string | null,
  day: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${DAY_USAGE_COLUMNS} FROM usage_events
       WHERE account_id = ?1 AND ip_key = ?2 AND created_at >= ?3`,
    )
    .bind(poolId, ipKey ?? '', day);
}

/** The pool's spend since `day`, all users together. */
export function poolDaySpendStatement(
  db: D1Database,
  poolId: string,
  day: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COALESCE(SUM(${SPEND_EXPR}), 0) AS spend FROM usage_events
       WHERE account_id = ?1 AND created_at >= ?2`,
    )
    .bind(poolId, day);
}
