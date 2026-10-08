// `usage_events` writes shared by the meter, reconciliation and the open
// pool. Each one is a single conditional statement (`WHERE status = 'pending'`),
// so a row settles at most once whoever gets there first (inline settle,
// deferred reconcile, cron, the pool's expiry alarm), and a replay can never
// double-charge.
import type { UsagePurpose } from '@tangent/shared';
import { chargeMicros } from './pricing.js';

export type UsageFunding = 'personal' | 'pool';

/**
 * How a row settled. `cost`: the cost the stream reported; `generation`: from
 * OpenRouter's generation lookup; `tokens`: tokens × the price table (pool);
 * `hold`: the full hold (pool, nothing observed); `released`: charged 0
 * because nothing was billed upstream (the pool's refund of a reservation);
 * `unresolved`: given up at 0 (personal).
 */
export type SettleReason = 'cost' | 'generation' | 'tokens' | 'hold' | 'released' | 'unresolved';

export interface PendingUsageRow {
  id: string;
  accountId: string;
  treeId: string | null;
  nodeId: string | null;
  branchId?: string | null;
  userId?: string | null;
  /** Default `personal`. */
  funding?: UsageFunding;
  /** Pool rows only. */
  ipKey?: string | null;
  purpose: UsagePurpose;
  providerId: string;
  model: string;
  holdMicros: number;
  markupBps: number;
  /** OpenRouter's credit-purchase fee in force when the call started (OPENROUTER_FEE_BPS). */
  feeBps: number;
  createdAt: string;
}

export function insertPendingUsageStatement(
  db: D1Database,
  row: PendingUsageRow,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO usage_events
         (id, account_id, tree_id, node_id, branch_id, user_id, funding, ip_key, purpose,
          provider_id, model, status, hold_micros, markup_bps, fee_bps, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.accountId,
      row.treeId,
      row.nodeId,
      row.branchId ?? null,
      row.userId ?? null,
      row.funding ?? 'personal',
      row.ipKey ?? null,
      row.purpose,
      row.providerId,
      row.model,
      row.holdMicros,
      row.markupBps,
      row.feeBps,
      row.createdAt,
    );
}

/**
 * The available balance of account `?1`, as SQL: Σ grants − Σ settled
 * charges − Σ pending holds (ledger.ts). Conditions on it below run inside
 * the statement that writes, so concurrent writers can't both pass.
 */
const AVAILABLE_SQL = `(SELECT COALESCE(SUM(amount_micros), 0) FROM credit_grants WHERE account_id = ?1)
  - (SELECT COALESCE(SUM(charge_micros), 0) FROM usage_events WHERE account_id = ?1 AND status = 'settled')
  - (SELECT COALESCE(SUM(hold_micros), 0) FROM usage_events WHERE account_id = ?1 AND status = 'pending')`;

/**
 * Personal credit: inserts the pending row only while the account's
 * available balance covers its hold and, with `maxPending`, fewer than that
 * many of its calls are pending. One statement, so calls racing from
 * different trees (different Durable Objects) or Workers can't all pass.
 * Resolves false when nothing was inserted.
 */
export async function reservePersonalUsage(
  db: D1Database,
  row: PendingUsageRow,
  maxPending: number | null,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO usage_events
         (id, account_id, tree_id, node_id, branch_id, user_id, funding, ip_key, purpose,
          provider_id, model, status, hold_micros, markup_bps, fee_bps, created_at)
       SELECT ?2, ?1, ?3, ?4, ?5, ?6, 'personal', NULL, ?7, ?8, ?9, 'pending', ?10, ?11, ?12, ?13
       WHERE ${AVAILABLE_SQL} >= ?10
         AND (?14 IS NULL OR
              (SELECT COUNT(*) FROM usage_events WHERE account_id = ?1 AND status = 'pending') < ?14)`,
    )
    .bind(
      row.accountId,
      row.id,
      row.treeId,
      row.nodeId,
      row.branchId ?? null,
      row.userId ?? null,
      row.purpose,
      row.providerId,
      row.model,
      row.holdMicros,
      row.markupBps,
      row.feeBps,
      row.createdAt,
      maxPending,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Personal credit: sets a pending, undispatched reservation's hold to
 * `holdMicros` once the call's own worst case is known, and its node (the
 * reply's, unknown when it was reserved). Lowering the hold always succeeds;
 * raising it only while the rest of the available balance covers the
 * increase, in the same statement. Resolves the row's markup and fee, or
 * null when it is no longer such a row or the balance can't cover the hold.
 */
export async function repriceReservation(
  db: D1Database,
  usageId: string,
  accountId: string,
  holdMicros: number,
  nodeId: string | null,
): Promise<{ feeBps: number; markupBps: number } | null> {
  const row = await db
    .prepare(
      `UPDATE usage_events SET hold_micros = ?3, node_id = COALESCE(node_id, ?4)
       WHERE id = ?2 AND account_id = ?1 AND funding = 'personal' AND status = 'pending'
         AND dispatched_at IS NULL
         AND (?3 <= hold_micros OR ${AVAILABLE_SQL} + hold_micros >= ?3)
       RETURNING fee_bps, markup_bps`,
    )
    .bind(accountId, usageId, holdMicros, nodeId)
    .first<{ fee_bps: number; markup_bps: number }>();
  return row ? { feeBps: row.fee_bps, markupBps: row.markup_bps } : null;
}

/**
 * Records the upstream generation id while the row is pending. `OR IGNORE`:
 * an id already claimed by another row (the unique index) is skipped rather
 * than failing; the row then settles through its own reported cost or the cron.
 */
export async function setGenerationId(
  db: D1Database,
  usageId: string,
  generationId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE OR IGNORE usage_events SET generation_id = ? WHERE id = ? AND status = 'pending'",
    )
    .bind(generationId, usageId)
    .run();
}

/**
 * Stamps `dispatched_at` right before the request goes to the provider (a
 * pool call, or a reply reserved on credit before its nodes were written), so
 * `releaseUndispatched` leaves the row to its meter. Resolves false when the
 * row is no longer pending (expired meanwhile), or was created before
 * `createdNotBefore` (too close to its TTL for the call to end before the
 * expiry alarm may release it): the call must then not be made.
 */
export async function markDispatched(
  db: D1Database,
  usageId: string,
  now = new Date(),
  createdNotBefore: Date | null = null,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE usage_events SET dispatched_at = ?1
       WHERE id = ?2 AND status = 'pending' AND dispatched_at IS NULL
         AND (?3 IS NULL OR created_at >= ?3)`,
    )
    .bind(now.toISOString(), usageId, createdNotBefore?.toISOString() ?? null)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Pool: lowers a pending reservation's hold to `holdMicros` (never raises it),
 * once the exact worst case of the call is known. Only raises the pool's
 * available balance, so it needs no lock. Resolves the row's resulting hold,
 * fee and markup, or null when it is no longer an undispatched pending row of
 * `accountId` (another call already claimed it).
 */
export async function shrinkHold(
  db: D1Database,
  usageId: string,
  accountId: string,
  holdMicros: number,
): Promise<{ holdMicros: number; feeBps: number; markupBps: number } | null> {
  const row = await db
    .prepare(
      `UPDATE usage_events SET hold_micros = MIN(hold_micros, ?)
       WHERE id = ? AND account_id = ? AND funding = 'pool' AND status = 'pending'
         AND dispatched_at IS NULL
       RETURNING hold_micros, fee_bps, markup_bps`,
    )
    .bind(holdMicros, usageId, accountId)
    .first<{ hold_micros: number; fee_bps: number; markup_bps: number }>();
  return row
    ? { holdMicros: row.hold_micros, feeBps: row.fee_bps, markupBps: row.markup_bps }
    : null;
}

export interface Settlement {
  /** Provider cost in nano-USD (0 when nothing was billed upstream). */
  costNanos: number;
  markupBps: number;
  /** The row's stored `fee_bps`, so a later config change never reprices it. */
  feeBps: number;
  /** Default `cost`. */
  reason?: SettleReason;
  /** Pool `hold` settlements: charge the row's full hold instead of the cost. */
  chargeHold?: boolean;
  /**
   * Settle only while `dispatched_at` is still NULL (expiry's `released`), so
   * a call stamped after the row was read is never released at 0.
   */
  requireUndispatched?: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Web searches the call ran; null/absent keeps the stored count. */
  webSearches?: number | null;
  now?: Date;
}

export interface SettleResult {
  /** False when the row was no longer pending (settled elsewhere first). */
  changed: boolean;
  /** Pool rows: the cost exceeded the hold, so the charge was clamped to it. */
  clamped: boolean;
}

/**
 * Settles a pending row. Pool rows are charged at most their hold: the excess
 * is recorded in `overage_micros` (absorbed by the operator, and bounded by
 * the pool's overage breaker), so a settle can never lower the pool's
 * available balance.
 */
export async function settleUsage(
  db: D1Database,
  usageId: string,
  s: Settlement,
): Promise<SettleResult> {
  // NULL actual = the row's own hold.
  const actual = s.chargeHold ? null : chargeMicros(s.costNanos, s.markupBps, s.feeBps);
  const row = await db
    .prepare(
      `UPDATE usage_events
       SET status = 'settled', cost_nanos = ?1,
           charge_micros = CASE WHEN funding = 'pool' THEN MIN(COALESCE(?2, hold_micros), hold_micros)
                                ELSE COALESCE(?2, hold_micros) END,
           overage_micros = CASE WHEN funding = 'pool' THEN MAX(0, COALESCE(?2, hold_micros) - hold_micros)
                                 ELSE 0 END,
           settle_reason = ?3,
           input_tokens = COALESCE(?4, input_tokens), output_tokens = COALESCE(?5, output_tokens),
           settled_at = ?6, web_searches = COALESCE(?9, web_searches)
       WHERE id = ?7 AND status = 'pending' AND (?8 = 0 OR dispatched_at IS NULL)
       RETURNING overage_micros`,
    )
    .bind(
      s.chargeHold ? null : s.costNanos,
      actual,
      s.reason ?? 'cost',
      s.inputTokens ?? null,
      s.outputTokens ?? null,
      (s.now ?? new Date()).toISOString(),
      usageId,
      s.requireUndispatched ? 1 : 0,
      s.webSearches ?? null,
    )
    .first<{ overage_micros: number }>();
  return { changed: row !== null, clamped: (row?.overage_micros ?? 0) > 0 };
}

/**
 * Releases a reservation at 0 while nothing was dispatched on it (a reply
 * reserved before its nodes were written, on the pool or on credit, whose
 * send never reached the provider). A dispatched or settled row is left to
 * its meter and the backstops (the pool's expiry, the reconcile cron).
 */
export async function releaseUndispatched(db: D1Database, usageId: string): Promise<boolean> {
  const { changed } = await settleUsage(db, usageId, {
    costNanos: 0,
    markupBps: 0,
    feeBps: 0,
    reason: 'released',
    requireUndispatched: true,
  });
  return changed;
}

/** Gives up on a row: `unresolved`, charged 0, for manual review. */
export async function markUnresolved(
  db: D1Database,
  usageId: string,
  now = new Date(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE usage_events SET status = 'unresolved', charge_micros = 0, settle_reason = 'unresolved', settled_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(now.toISOString(), usageId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
