// What an admin decides about reported shares, and the queue they decide
// from. A removal is a strike against the share's owner; strikes are derived
// from the reports, never stored, so restoring a share (which rejects its
// reports) takes its strike back.
import { NotFoundError } from '@tangent/core';
import {
  ADMIN_MODERATION_PAGE,
  type AdminReport,
  type AdminReportShareState,
  type AdminReportsQuery,
  type AdminReportsResponse,
  type ReportAction,
  type ReportResolution,
  type Share,
  type ShareTakedown,
} from '@tangent/shared';
import { ACCOUNT_PREFIX, userIdOfAccount } from '../auth/account.js';
import { createD1Repositories } from '../db/d1-repositories.js';
import type { SqlRow } from '../db/rows.js';
import type { shareReports, shares } from '../db/schema.js';
import { decodeCursor, encodeCursor } from '../http/cursor.js';
import { auditStatement, recordAudit } from './audit.js';
import { purgeShare } from './cache.js';
import { pendingReportsTakeDown, setTakedown } from './reports.js';

/**
 * Removed shares, each with at least one report acted on, that suspend their
 * owner's sharing. Counted by share, so several reports of one conversation
 * are one strike.
 */
const STRIKES_TO_SUSPEND = 2;

type ReportRow = SqlRow<typeof shareReports>;
type ShareRef = Pick<Share, 'id' | 'token' | 'accountId' | 'version' | 'takedown'>;

interface QueueRow extends ReportRow {
  owner_email: string | null;
  share_exists: number;
  takedown: SqlRow<typeof shares>['takedown'];
  revoked_at: SqlRow<typeof shares>['revoked_at'];
  expires_at: SqlRow<typeof shares>['expires_at'];
  reporters: number;
  held: number;
}

/**
 * A report with what the queue shows beside it: the owner's address (from a
 * hold once the account is gone), the share's state, how many people
 * reported it and whether it is held.
 */
const QUEUE_SELECT = `SELECT r.*,
  COALESCE(u.email, (SELECT h.subject_email FROM legal_holds h
    WHERE h.share_id = r.share_id AND h.subject_email IS NOT NULL LIMIT 1)) AS owner_email,
  s.id IS NOT NULL AS share_exists, s.takedown, s.revoked_at, s.expires_at,
  (SELECT COUNT(DISTINCT COALESCE(o.reporter_key, o.id)) FROM share_reports o
    WHERE o.share_id = r.share_id) AS reporters,
  EXISTS (SELECT 1 FROM legal_holds h
    WHERE h.share_id = r.share_id AND h.released_at IS NULL) AS held
  FROM share_reports r
  LEFT JOIN auth_users u ON u.id = substr(r.owner_account_id, ${ACCOUNT_PREFIX.length + 1})
  LEFT JOIN shares s ON s.id = r.share_id`;

function shareStateOf(row: QueueRow, now: string): AdminReportShareState {
  if (!row.share_exists) return 'deleted';
  if (row.takedown) return row.takedown;
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && row.expires_at <= now) return 'expired';
  return 'active';
}

function toAdminReport(row: QueueRow, now: string): AdminReport {
  return {
    id: row.id,
    shareId: row.share_id,
    shareToken: row.share_token,
    ownerUserId: userIdOfAccount(row.owner_account_id),
    ownerEmail: row.owner_email,
    category: row.category,
    details: row.details,
    reporterEmail: row.reporter_email,
    createdAt: row.created_at,
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    notes: row.notes,
    shareState: shareStateOf(row, now),
    shareReporters: row.reporters,
    held: row.held === 1,
  };
}

/**
 * One page of reports: the undecided ones oldest first (the queue, in the
 * order they came in), or all of them newest first.
 */
export async function listReports(
  db: D1Database,
  { status, cursor }: AdminReportsQuery,
): Promise<AdminReportsResponse> {
  const pending = status === 'pending';
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (pending) where.push(`r.resolution = 'pending'`);
  if (cursor) {
    const after = decodeCursor(cursor);
    params.push(new Date(after.at).toISOString(), after.id);
    const cmp = pending ? '>' : '<';
    where.push(`(r.created_at ${cmp} ?1 OR (r.created_at = ?1 AND r.id ${cmp} ?2))`);
  }
  params.push(ADMIN_MODERATION_PAGE + 1);
  const order = pending ? 'ASC' : 'DESC';
  const { results } = await db
    .prepare(
      `${QUEUE_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.created_at ${order}, r.id ${order} LIMIT ?${params.length}`,
    )
    .bind(...params)
    .all<QueueRow>();
  const page = results.slice(0, ADMIN_MODERATION_PAGE);
  const last = page.at(-1);
  const at = new Date().toISOString();
  return {
    reports: page.map((row) => toAdminReport(row, at)),
    nextCursor:
      results.length > ADMIN_MODERATION_PAGE && last
        ? encodeCursor(Date.parse(last.created_at), last.id)
        : null,
  };
}

/** One report as the queue lists it. */
async function getReport(db: D1Database, reportId: string): Promise<AdminReport> {
  const row = await db.prepare(`${QUEUE_SELECT} WHERE r.id = ?1`).bind(reportId).first<QueueRow>();
  if (!row) throw new NotFoundError('Report');
  return toAdminReport(row, new Date().toISOString());
}

interface Decider {
  /** The admin's user id; null for the dev bypass. */
  adminId: string | null;
  /** The report decided on, which also carries `notes`; none for a decision on the share itself. */
  reportId?: string;
  notes?: string | null;
}

/**
 * Decides an admin's report action (`ReportAction`, in @tangent/shared): the
 * report is resolved, the share's takedown follows, the owner's strikes are
 * counted, each change audited and the share's cached copies purged.
 */
export async function resolveReport(
  db: D1Database,
  reportId: string,
  action: ReportAction,
  by: Omit<Decider, 'reportId'>,
): Promise<AdminReport> {
  const report = await db
    .prepare('SELECT * FROM share_reports WHERE id = ?')
    .bind(reportId)
    .first<ReportRow>();
  if (!report) throw new NotFoundError('Report');
  // A deleted share still has its reports decided and counted.
  const share: ShareRef = (await createD1Repositories(db).shares.getShare(report.share_id)) ?? {
    id: report.share_id,
    token: report.share_token,
    accountId: report.owner_account_id,
    version: 0,
    takedown: null,
  };
  const decider = { ...by, reportId };
  if (action === 'remove') await removeShare(db, share, decider);
  else if (action === 'restore') await restoreShare(db, share, decider);
  else {
    await resolve(db, share, 'reject', [], decider);
    if (share.takedown === 'pending_review' && !(await pendingReportsTakeDown(db, share.id)))
      await takedown(db, share, null, decider);
  }
  return getReport(db, reportId);
}

/**
 * Takes the share down for good. Its undecided reports (and `by.reportId`)
 * count as acted on, which may suspend the owner (`STRIKES_TO_SUSPEND`); a
 * share removed with no report against it is no strike.
 */
export async function removeShare(db: D1Database, share: ShareRef, by: Decider): Promise<void> {
  await takedown(db, share, 'removed', by);
  if ((await resolve(db, share, 'remove', ['pending'], by)) > 0)
    await applyStrikes(db, share.accountId);
}

/**
 * Puts a taken-down share back up and rejects its reports, decided or not:
 * the admin found nothing wrong, so a removal's strike goes. A suspension the
 * strikes set stays until an admin lifts it.
 */
export async function restoreShare(db: D1Database, share: ShareRef, by: Decider): Promise<void> {
  await takedown(db, share, null, by);
  await resolve(db, share, 'restore', ['pending', 'actioned'], by);
}

async function takedown(
  db: D1Database,
  share: ShareRef,
  to: ShareTakedown | null,
  by: Decider,
): Promise<void> {
  const changed = await setTakedown(db, share, to, {
    actor: 'admin',
    actorUserId: by.adminId,
    reportId: by.reportId ?? null,
  });
  if (changed) await purgeShare(share.token, [share.version]);
}

/**
 * Resolves the share's reports in `from` and `by.reportId` (whatever its
 * resolution) as `action` makes them, with an audit row each; `by.notes` goes
 * on `by.reportId` only. Returns how many changed.
 */
async function resolve(
  db: D1Database,
  share: ShareRef,
  action: ReportAction,
  from: readonly ReportResolution[],
  by: Decider,
): Promise<number> {
  const now = new Date();
  const resolution = action === 'remove' ? 'actioned' : 'rejected';
  const { results } = await db
    .prepare(
      `UPDATE share_reports SET resolution = ?3, resolved_at = ?4, resolved_by = ?5,
         notes = CASE WHEN id = ?2 AND ?6 IS NOT NULL THEN ?6 ELSE notes END
       WHERE share_id = ?1
         AND (id = ?2 OR (resolution IN (SELECT value FROM json_each(?7)) AND resolution <> ?3))
       RETURNING id`,
    )
    .bind(
      share.id,
      by.reportId ?? null,
      resolution,
      now.toISOString(),
      by.adminId,
      by.notes ?? null,
      JSON.stringify(from),
    )
    .all<Pick<ReportRow, 'id'>>();
  if (results.length > 0) {
    await db.batch(
      results.map(({ id }) =>
        auditStatement(
          db,
          {
            kind: 'report_resolved',
            actor: 'admin',
            actorUserId: by.adminId,
            subjectUserId: userIdOfAccount(share.accountId),
            shareId: share.id,
            reportId: id,
            data: { action, resolution },
          },
          now,
        ),
      ),
    );
  }
  return results.length;
}

/**
 * The owner's strikes: their shares with a report acted on. Derived, so a
 * restore that rejects the reports takes the strike back.
 */
async function strikesOf(db: D1Database, ownerAccountId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT share_id) AS n FROM share_reports
       WHERE owner_account_id = ?1 AND resolution = 'actioned'`,
    )
    .bind(ownerAccountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Suspends the owner's sharing once they have `STRIKES_TO_SUSPEND` strikes, with its audit row. */
async function applyStrikes(db: D1Database, ownerAccountId: string): Promise<void> {
  const userId = userIdOfAccount(ownerAccountId);
  if (!userId) return;
  const strikes = await strikesOf(db, ownerAccountId);
  if (strikes < STRIKES_TO_SUSPEND) return;
  const suspended = await db
    .prepare(
      'UPDATE auth_users SET sharing_suspended = 1 WHERE id = ? AND sharing_suspended = 0 RETURNING id',
    )
    .bind(userId)
    .first<{ id: string }>();
  if (!suspended) return;
  await recordAudit(db, {
    kind: 'sharing_suspended',
    actor: 'system',
    actorUserId: null,
    subjectUserId: userId,
    data: { suspended: true, strikes },
  });
}
