// Reports filed from a share page (http/report-page.tsx) and what they set
// off at once. Taking a link down first is cheap: it is unlisted, an admin
// can put it back up, and leaving reported content up is the risky case. The
// owner sees only that the link is unavailable, never the report.
import type { ReportCategory, Share, ShareTakedown } from '@tangent/shared';
import { sendAlert, type AlertReason } from '../alerts.js';
import { userIdOfAccount } from '../auth/account.js';
import type { AppEnv } from '../env.js';
import { logEvent } from '../log.js';
import { auditStatement, recordAudit } from './audit.js';
import { purgeShare } from './cache.js';
import { placeHold } from './legal-hold.js';

/** Categories that take the link down on the first report: crimes, and copyright (take down, then sort out). */
const TAKEDOWN_AT_ONCE: ReadonlySet<ReportCategory> = new Set([
  'csam',
  'violent_or_illegal',
  'copyright',
]);

/**
 * Categories that take the link down once two reporters agree: one report
 * of defamation or harassment is often a dispute, two independent ones
 * rarely are.
 */
const TAKEDOWN_ON_SECOND: readonly ReportCategory[] = ['defamation', 'harassment_privacy'];
const INDEPENDENT_REPORTS = 2;

/** Categories that also put the conversation on legal hold and alert the operator. */
const URGENT: Partial<Record<ReportCategory, AlertReason>> = {
  csam: 'report_csam',
  violent_or_illegal: 'report_violent_or_illegal',
};

export interface NewReport {
  /** The reported share, active when the report was filed. */
  share: Share;
  category: ReportCategory;
  details: string;
  /** Optional, for a reply. */
  reporterEmail: string | null;
  /** Who reported, to count independent reports (`reporterKeyOf`); null when unknown. */
  reporterKey: string | null;
  /** The reporter's user id when signed in. */
  reporterUserId: string | null;
}

/**
 * Who filed a report, so one person reporting twice counts once: the
 * signed-in user's id, else the network's daily key (`networkKey`).
 */
export function reporterKeyOf(userId: string | null, network: string | null): string | null {
  if (userId) return `u:${userId}`;
  return network ? `n:${network}` : null;
}

/**
 * Stores a report with its audit row, then acts on it: takes the link down
 * for review (`TAKEDOWN_AT_ONCE`, or `INDEPENDENT_REPORTS` pending reports
 * from different reporters in `TAKEDOWN_ON_SECOND`), and for `URGENT`
 * categories places a legal hold and alerts the operator. A failed hold is
 * logged, not thrown: the report and the takedown stand, and the alert asks
 * the operator to act. `origin` is the public origin, for the alert's link.
 */
export async function fileReport(
  env: AppEnv,
  origin: string,
  report: NewReport,
  now = new Date(),
): Promise<{ reportId: string; takenDown: boolean }> {
  const { share, category } = report;
  const reportId = crypto.randomUUID();
  const subjectUserId = userIdOfAccount(share.accountId);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO share_reports
         (id, share_id, share_token, owner_account_id, category, details,
          reporter_email, reporter_key, reporter_user_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(
      reportId,
      share.id,
      share.token,
      share.accountId,
      category,
      report.details,
      report.reporterEmail,
      report.reporterKey,
      report.reporterUserId,
      now.toISOString(),
    ),
    auditStatement(
      env.DB,
      {
        kind: 'report_received',
        actor: 'reporter',
        actorUserId: report.reporterUserId,
        subjectUserId,
        shareId: share.id,
        reportId,
        data: { category },
      },
      now,
    ),
  ]);

  const takenDown =
    (TAKEDOWN_AT_ONCE.has(category) ||
      (TAKEDOWN_ON_SECOND.includes(category) &&
        (await independentReports(env.DB, share.id)) >= INDEPENDENT_REPORTS)) &&
    (await setTakedown(env.DB, share, 'pending_review', {
      actor: 'system',
      actorUserId: null,
      reportId,
    }));

  const alert = URGENT[category];
  if (alert) {
    let holdId: string | null = null;
    try {
      ({ holdId } = await placeHold(
        env.DB,
        {
          reason: category === 'csam' ? 'csam' : 'violent_or_illegal',
          actor: 'system',
          createdBy: null,
          shareId: share.id,
          reportId,
        },
        now,
      ));
    } catch (err) {
      logEvent('error', 'report_hold_failed', { shareId: share.id, reportId, error: err });
    }
    await sendAlert(env, origin, {
      reason: alert,
      shareId: share.id,
      subjectUserId,
      holdId,
      reportId,
    });
  }
  if (takenDown) await purgeShare(share.token, [share.version]);
  logEvent('info', 'share_reported', { shareId: share.id, reportId, category, takenDown });
  return { reportId, takenDown };
}

/**
 * Whether the share's undecided reports alone would take it down, as
 * `fileReport` does: one in `TAKEDOWN_AT_ONCE`, or `INDEPENDENT_REPORTS`
 * reporters in `TAKEDOWN_ON_SECOND`. Rejecting one report puts the share
 * back up only when this is false.
 */
export async function pendingReportsTakeDown(db: D1Database, shareId: string): Promise<boolean> {
  const atOnce = [...TAKEDOWN_AT_ONCE];
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM share_reports
         WHERE share_id = ?1 AND resolution = 'pending'
           AND category IN (${atOnce.map((_, i) => `?${i + 2}`).join(', ')})) AS n`,
    )
    .bind(shareId, ...atOnce)
    .first<{ n: number }>();
  return row?.n === 1 || (await independentReports(db, shareId)) >= INDEPENDENT_REPORTS;
}

/** Distinct reporters of the share's pending `TAKEDOWN_ON_SECOND` reports. */
async function independentReports(db: D1Database, shareId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT reporter_key) AS n FROM share_reports
       WHERE share_id = ?1 AND resolution = 'pending' AND reporter_key IS NOT NULL
         AND category IN (${TAKEDOWN_ON_SECOND.map((_, i) => `?${i + 2}`).join(', ')})`,
    )
    .bind(shareId, ...TAKEDOWN_ON_SECOND)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Sets a share's takedown (null puts it back up) and audits the change;
 * false, with nothing recorded, when the share is gone or already in that
 * state. The caller purges the edge cache.
 */
export async function setTakedown(
  db: D1Database,
  share: Pick<Share, 'id' | 'accountId' | 'version'>,
  takedown: ShareTakedown | null,
  by: { actor: 'admin' | 'system'; actorUserId: string | null; reportId?: string | null },
): Promise<boolean> {
  const changed = await db
    .prepare('UPDATE shares SET takedown = ?1 WHERE id = ?2 AND takedown IS NOT ?1 RETURNING id')
    .bind(takedown, share.id)
    .first<{ id: string }>();
  if (!changed) return false;
  await recordAudit(db, {
    kind: 'share_takedown',
    actor: by.actor,
    actorUserId: by.actorUserId,
    subjectUserId: userIdOfAccount(share.accountId),
    shareId: share.id,
    reportId: by.reportId ?? null,
    data: { takedown, version: share.version },
  });
  return true;
}
