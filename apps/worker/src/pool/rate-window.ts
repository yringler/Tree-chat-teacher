// PoolBank's per-minute rate limits: one counter per caller and per network,
// in fixed one-minute windows in the object's SQLite storage. They fail
// closed: if the counters can't be read or written, the request is refused.
import type { PoolRateLimits } from '../config.js';
import { logEvent } from '../log.js';

/** The rate limits' fixed window. */
const MINUTE_MS = 60_000;

/** A request the rate limits refuse: when the window resets, and the limit hit (null = storage failed). */
export interface RateLimited {
  resetAt: string;
  limit: number | null;
}

export class RateWindow {
  private tableReady = false;

  constructor(private readonly storage: DurableObjectStorage) {}

  /**
   * Counts one request against the per-minute limits of the caller and their
   * network, or says when it may come back when either is used up. A refused
   * request isn't counted. Fails closed: any storage error refuses.
   */
  take(
    req: { poolId: string; userId: string; ipKey: string | null; limits: PoolRateLimits },
    now: Date,
  ): RateLimited | null {
    const minute = Math.floor(now.getTime() / MINUTE_MS);
    const resetAt = new Date((minute + 1) * MINUTE_MS).toISOString();
    const buckets: { key: string; limit: number }[] = [
      { key: `u:${req.userId}`, limit: req.limits.userPerMinute },
    ];
    if (req.ipKey !== null) buckets.push({ key: `ip:${req.ipKey}`, limit: req.limits.ipPerMinute });
    try {
      const sql = this.table();
      // Older windows are over: what remains is this minute's counts.
      sql.exec('DELETE FROM rate_windows WHERE minute <> ?', minute);
      for (const b of buckets) {
        const row = sql
          .exec<{ count: number }>('SELECT count FROM rate_windows WHERE key = ?', b.key)
          .toArray()[0];
        if ((row?.count ?? 0) >= b.limit) return { resetAt, limit: b.limit };
      }
      for (const b of buckets)
        sql.exec(
          `INSERT INTO rate_windows (key, minute, count) VALUES (?, ?, 1)
           ON CONFLICT(key) DO UPDATE SET count = count + 1`,
          b.key,
          minute,
        );
      return null;
    } catch (err) {
      logEvent('error', 'pool_rate_unavailable', { poolId: req.poolId, error: String(err) });
      return { resetAt, limit: null };
    }
  }

  /** Drops `userId`'s counter. */
  forget(userId: string): void {
    this.table().exec('DELETE FROM rate_windows WHERE key = ?', `u:${userId}`);
  }

  /** The object's SQLite storage, with the rate-limit table created on first use. */
  private table(): SqlStorage {
    const sql = this.storage.sql;
    if (!this.tableReady) {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS rate_windows (
           key TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL)`,
      );
      this.tableReady = true;
    }
    return sql;
  }
}
