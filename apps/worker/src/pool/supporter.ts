// The supporter tier (spec §5, owner resolution of D5): a user whose net
// purchases are above $0 gets higher pool caps. It is computed server-side
// from the ledger, never passed in by a client.
//
//   net = Σ gross_micros of the user's `purchase` grants (personal or pool)
//       + Σ (negative) gross of their `refund` grants (refunds and disputes)
//
// Net purchases of less than a cent count as none: each partial refund's
// pre-tax share is rounded on its own, so a purchase refunded in full, in
// parts, can leave a few micro-USD of rounding behind.
//
// Admin adjustments and membership credit never count. Grants from before
// migration 0010 have no `user_id`; personal ones count through their ledger
// account `u_<userId>`, and their refunds (which recorded no gross) through
// their amount, which was the refunded pre-tax share. With
// `SUPPORTER_WINDOW_MONTHS` set, the latest purchase must also be that recent.
import { accountIdForUser } from '../auth/account.js';

/** Net purchases at or below this (one cent) are rounding residue, not a purchase. */
export const SUPPORTER_ROUNDING_MICROS = 10_000;

interface SupporterRow {
  net: number | null;
  last_purchase: string | null;
}

/** The query `isSupporter` runs, for callers that batch it (PoolBank.reserve). */
export function supporterStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT
         SUM(CASE WHEN kind = 'purchase' THEN COALESCE(gross_micros, 0)
                  ELSE COALESCE(gross_micros, amount_micros) END) AS net,
         MAX(CASE WHEN kind = 'purchase' THEN created_at END) AS last_purchase
       FROM credit_grants
       WHERE kind IN ('purchase', 'refund')
         AND (user_id = ?1 OR (user_id IS NULL AND account_id = ?2))`,
    )
    .bind(userId, accountIdForUser(userId));
}

/** The start of the supporter window ending at `now`: `months` calendar months earlier (UTC). */
export function windowStart(now: Date, months: number): Date {
  const start = new Date(now.getTime());
  start.setUTCMonth(start.getUTCMonth() - months);
  return start;
}

/** Reads `supporterStatement`'s row. */
export function supporterFrom(
  row: SupporterRow | null | undefined,
  now: Date,
  windowMonths: number | null,
): boolean {
  if (!row || Number(row.net ?? 0) <= SUPPORTER_ROUNDING_MICROS || !row.last_purchase) return false;
  if (windowMonths === null) return true;
  return row.last_purchase >= windowStart(now, windowMonths).toISOString();
}

/**
 * True when `userId` has net purchases above $0 (and, with `windowMonths`,
 * bought within that many months of `now`).
 */
export async function isSupporter(
  db: D1Database,
  userId: string,
  now: Date,
  windowMonths: number | null,
): Promise<boolean> {
  const row = await supporterStatement(db, userId).first<SupporterRow>();
  return supporterFrom(row, now, windowMonths);
}
