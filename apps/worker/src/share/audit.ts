// The moderation audit log (`audit_events`): what happened to shares, holds
// and sharing rights, and who did it. Rows are only ever inserted, here; the
// record is the evidence that the operator acted, so nothing updates or
// deletes one (a test checks the sources). `data` carries ids, versions and
// scores, never message content.
import type { CategoryScores, ModerationCategory, SharePublish } from '@tangent/core';
import type {
  HoldReportKind,
  LegalHoldReason,
  ReportAction,
  ReportCategory,
  ShareScope,
  ShareTakedown,
} from '@tangent/shared';
import type { auditEvents } from '../db/schema.js';
import type { SqlRow } from '../db/rows.js';
import { logEvent } from '../log.js';

type AuditActor = SqlRow<typeof auditEvents>['actor'];

interface AuditBase {
  actor: AuditActor;
  /** The user who acted; null for the system and anonymous reporters. */
  actorUserId: string | null;
  /** The user the event is about: the share's owner, the held account. */
  subjectUserId: string | null;
  shareId?: string | null;
  reportId?: string | null;
  holdId?: string | null;
}

/** A change to one share by its owner (an admin's takedown is a `TakedownAuditEvent`). */
export interface ShareAuditEvent extends AuditBase {
  kind: 'share_created' | 'share_updated' | 'share_republished' | 'share_revoked' | 'share_deleted';
  shareId: string;
  data: { version: number; scope?: ShareScope };
}

/**
 * A publish the classifier screened (share/moderation.ts), allowed or not:
 * the highest score of each category, never the text. A refused create's
 * share id never reaches `shares`.
 */
export interface ScreenAuditEvent extends AuditBase {
  kind: 'share_screened';
  shareId: string;
  data: {
    trigger: SharePublish['trigger'];
    verdict: 'allow' | 'block' | 'csam_flag';
    /** The categories over their thresholds, when blocked. */
    reasons?: readonly ModerationCategory[];
    maxScores: CategoryScores;
  };
}

/** A legal hold placed, released, or reported outside Tangent (share/legal-hold.ts). */
export type HoldAuditEvent = AuditBase & { holdId: string } & (
    | { kind: 'hold_placed'; data: { reason: LegalHoldReason; held: string[] } }
    | { kind: 'hold_released'; data: Record<string, never> }
    | { kind: 'hold_reported'; data: { kind: HoldReportKind; reference: string } }
  );

/**
 * A report filed from a share page (share/reports.ts): its category only,
 * never the reporter's text or address, which stay on the report.
 */
export interface ReportAuditEvent extends AuditBase {
  kind: 'report_received';
  shareId: string;
  reportId: string;
  data: { category: ReportCategory };
}

/** A share taken down (`pending_review`, `removed`) or put back up (null). */
export interface TakedownAuditEvent extends AuditBase {
  kind: 'share_takedown';
  shareId: string;
  data: { takedown: ShareTakedown | null; version: number };
}

/** An admin's decision on a report (share/review.ts): what they chose, and the report's resolution after it. */
export interface ReportResolvedAuditEvent extends AuditBase {
  kind: 'report_resolved';
  shareId: string;
  reportId: string;
  data: { action: ReportAction; resolution: 'actioned' | 'rejected' };
}

/**
 * A user's sharing suspended or lifted (`auth_users.sharing_suspended`): by an
 * admin, or by the strike rule, with the strikes that set it off.
 */
export interface SuspensionAuditEvent extends AuditBase {
  kind: 'sharing_suspended';
  data: { suspended: boolean; strikes?: number };
}

/**
 * An admin opened a share's content on the review page (http/review-page.ts):
 * from the stored snapshot, or from a hold's copy once the share is gone.
 */
export interface ReviewAuditEvent extends AuditBase {
  kind: 'share_reviewed';
  shareId: string;
  data: { source: 'share' | 'hold' };
}

export type AuditEvent =
  | ShareAuditEvent
  | ScreenAuditEvent
  | HoldAuditEvent
  | ReportAuditEvent
  | TakedownAuditEvent
  | ReportResolvedAuditEvent
  | SuspensionAuditEvent
  | ReviewAuditEvent;

/** The INSERT of one audit row, to run alone or in the batch that makes the change it records. */
export function auditStatement(
  db: D1Database,
  event: AuditEvent,
  now = new Date(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events
         (id, at, kind, actor, actor_user_id, subject_user_id, share_id, report_id, hold_id, data)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      crypto.randomUUID(),
      now.toISOString(),
      event.kind,
      event.actor,
      event.actorUserId,
      event.subjectUserId,
      event.shareId ?? null,
      event.reportId ?? null,
      event.holdId ?? null,
      JSON.stringify(event.data),
    );
}

/**
 * Records a change that has already happened. A failed insert can't undo
 * it, so it is logged (ids only) instead of failing the request.
 */
export async function recordAudit(db: D1Database, event: AuditEvent): Promise<void> {
  try {
    await auditStatement(db, event).run();
  } catch (err) {
    logEvent('error', 'audit_failed', {
      kind: event.kind,
      shareId: event.shareId,
      holdId: event.holdId,
      subjectUserId: event.subjectUserId,
      error: err,
    });
  }
}

/**
 * What counts against the user's daily limit since `since`, from the log
 * rather than from `shares`, so deleting links doesn't lift it: publishes the
 * classifier refused (every trigger), so retrying a flagged conversation
 * can't hammer it, plus, when `creating`, the links the user created.
 */
export async function publishesCountedSince(
  db: D1Database,
  userId: string,
  since: Date,
  { creating }: { creating: boolean },
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_events
       WHERE subject_user_id = ?1 AND at >= ?2
         AND ((?3 = 1 AND kind = 'share_created')
           OR (kind = 'share_screened' AND json_extract(data, '$.verdict') <> 'allow'))`,
    )
    .bind(userId, since.toISOString(), creating ? 1 : 0)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
