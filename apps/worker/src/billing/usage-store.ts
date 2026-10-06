// `usage_events` writes shared by the meter and reconciliation. Each one is a
// single conditional statement (`WHERE status = 'pending'`), so a row settles
// at most once whoever gets there first (inline settle, deferred reconcile,
// cron), and a replay can never double-charge.
import type { UsagePurpose } from '@tangent/shared';
import { chargeMicros } from './pricing.js';

export interface PendingUsageRow {
  id: string;
  accountId: string;
  treeId: string | null;
  nodeId: string | null;
  purpose: UsagePurpose;
  providerId: string;
  model: string;
  holdMicros: number;
  markupBps: number;
  /** OpenRouter's credit-purchase fee in force when the call started (OPENROUTER_FEE_BPS). */
  feeBps: number;
  createdAt: string;
}

export async function insertPendingUsage(db: D1Database, row: PendingUsageRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_events
         (id, account_id, tree_id, node_id, purpose, provider_id, model, status, hold_micros, markup_bps, fee_bps, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.accountId,
      row.treeId,
      row.nodeId,
      row.purpose,
      row.providerId,
      row.model,
      row.holdMicros,
      row.markupBps,
      row.feeBps,
      row.createdAt,
    )
    .run();
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

export interface Settlement {
  /** Provider cost in nano-USD (0 when nothing was billed upstream). */
  costNanos: number;
  markupBps: number;
  /** The row's stored `fee_bps`, so a later config change never reprices it. */
  feeBps: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Web searches the call ran; null/absent keeps the stored count. */
  webSearches?: number | null;
  now?: Date;
}

/** Settles a pending row; resolves false when it was no longer pending. */
export async function settleUsage(
  db: D1Database,
  usageId: string,
  s: Settlement,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE usage_events
       SET status = 'settled', cost_nanos = ?, charge_micros = ?,
           input_tokens = COALESCE(?, input_tokens), output_tokens = COALESCE(?, output_tokens),
           web_searches = COALESCE(?, web_searches), settled_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(
      s.costNanos,
      chargeMicros(s.costNanos, s.markupBps, s.feeBps),
      s.inputTokens ?? null,
      s.outputTokens ?? null,
      s.webSearches ?? null,
      (s.now ?? new Date()).toISOString(),
      usageId,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Gives up on a row: `unresolved`, charged 0, for manual review. */
export async function markUnresolved(
  db: D1Database,
  usageId: string,
  now = new Date(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE usage_events SET status = 'unresolved', charge_micros = 0, settled_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(now.toISOString(), usageId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
