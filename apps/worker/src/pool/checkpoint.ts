// PoolBank's balance checkpoint, kept in the object's storage: the pool's
// settled balance up to a moment no pending reservation predates, so a
// reservation's ledger sums cover only the rows since it. The cron advances
// it and verifies it against a full ledger sum once a day.
import {
  balanceStatement,
  readBalance,
  type BalanceCheckpoint,
  type BalanceRow,
} from '../billing/ledger.js';
import { DAY_MS, dayStart } from './day-usage.js';
import { logEvent } from '../log.js';

/** The cron re-verifies the checkpoint against a full ledger sum this often. */
const VERIFY_EVERY_MS = DAY_MS;

export interface PoolMaintainResult {
  checkpoint: BalanceCheckpoint | null;
  advanced: boolean;
  /** Full ledger sum minus the checkpointed sum, when verified this run (0 = consistent). */
  mismatchMicros: number | null;
}

interface StoredCheckpoint extends BalanceCheckpoint {
  poolId: string;
  verifiedAt: string | null;
}

/** The checkpoint `storage` holds for `poolId`, if any. */
export async function checkpointOf(
  storage: DurableObjectStorage,
  poolId: string,
): Promise<StoredCheckpoint | null> {
  const checkpoint = await storage.get<StoredCheckpoint>('checkpoint');
  return checkpoint?.poolId === poolId ? checkpoint : null;
}

/** PoolBank's `maintain`, on its `storage`. */
export async function maintainCheckpoint(
  storage: DurableObjectStorage,
  db: D1Database,
  req: {
    poolId: string;
    giveUpMs: number;
    now?: number;
  },
): Promise<PoolMaintainResult> {
  const now = new Date(req.now ?? Date.now());
  let checkpoint = await checkpointOf(storage, req.poolId);
  const target = new Date(
    Math.min(now.getTime() - 2 * req.giveUpMs, dayStart(now).getTime()),
  ).toISOString();
  let advanced = false;
  if (!checkpoint || checkpoint.at < target) {
    const stale = await db
      .prepare(
        `SELECT 1 AS one FROM usage_events
         WHERE account_id = ? AND status = 'pending' AND created_at < ? LIMIT 1`,
      )
      .bind(req.poolId, target)
      .first<{ one: number }>();
    if (!stale) {
      const row = await db
        .prepare(
          `SELECT ?2
             + (SELECT COALESCE(SUM(amount_micros), 0) FROM credit_grants
                WHERE account_id = ?1 AND created_at >= ?3 AND created_at < ?4)
             - (SELECT COALESCE(SUM(charge_micros), 0) FROM usage_events
                WHERE account_id = ?1 AND status <> 'pending' AND created_at >= ?3 AND created_at < ?4) AS balance`,
        )
        .bind(req.poolId, checkpoint?.balanceMicros ?? 0, checkpoint?.at ?? '', target)
        .first<{ balance: number }>();
      const next: StoredCheckpoint = {
        poolId: req.poolId,
        balanceMicros: Number(row?.balance ?? 0),
        at: target,
        verifiedAt: checkpoint?.verifiedAt ?? null,
      };
      await storage.put('checkpoint', next);
      checkpoint = next;
      advanced = true;
    }
  }

  let mismatchMicros: number | null = null;
  const stored = checkpoint ? ((await storage.get<StoredCheckpoint>('checkpoint')) ?? null) : null;
  if (
    stored &&
    (!stored.verifiedAt || now.getTime() - Date.parse(stored.verifiedAt) >= VERIFY_EVERY_MS)
  ) {
    // One batch, so both sums read the same snapshot (a row settling between them would differ).
    const [fullRes, sinceRes] = await db.batch<BalanceRow>([
      balanceStatement(db, req.poolId),
      balanceStatement(db, req.poolId, stored),
    ]);
    const full = readBalance(fullRes!.results[0]);
    const fromCheckpoint = readBalance(sinceRes!.results[0]);
    mismatchMicros = full.balanceMicros - fromCheckpoint.balanceMicros;
    if (mismatchMicros !== 0) {
      logEvent('error', 'pool_checkpoint_mismatch', {
        poolId: req.poolId,
        fullMicros: full.balanceMicros,
        checkpointedMicros: fromCheckpoint.balanceMicros,
      });
      // The ledger is the authority: drop the checkpoint, so reservations sum every row until the next advance.
      await storage.delete('checkpoint');
      checkpoint = null;
    } else {
      await storage.put('checkpoint', { ...stored, verifiedAt: now.toISOString() });
    }
  }
  return { checkpoint, advanced, mismatchMicros };
}
