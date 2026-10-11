// The moderation audit log (`audit_events`): what happened to shares, holds
// and sharing rights, and who did it. Rows are only ever inserted, here; the
// record is the evidence that the operator acted, so nothing updates or
// deletes one (a test checks the sources). `data` carries ids, versions and
// scores, never message content.
import type { HoldReportKind, LegalHoldReason, ShareScope } from '@tangent/shared';
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

/** A change to one share, by its owner or by an admin. */
export interface ShareAuditEvent extends AuditBase {
  kind: 'share_created' | 'share_updated' | 'share_republished' | 'share_revoked' | 'share_deleted';
  shareId: string;
  data: { version: number; scope?: ShareScope };
}

/** A legal hold placed, released, or reported outside Tangent (share/legal-hold.ts). */
export type HoldAuditEvent = AuditBase & { holdId: string } & (
    | { kind: 'hold_placed'; data: { reason: LegalHoldReason; held: string[] } }
    | { kind: 'hold_released'; data: Record<string, never> }
    | { kind: 'hold_reported'; data: { kind: HoldReportKind; reference: string } }
  );

export type AuditEvent = ShareAuditEvent | HoldAuditEvent;

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
 * Links the user created since `since`, counted from the log rather than
 * from `shares`, so deleting links doesn't lift the daily limit.
 */
export async function sharesCreatedSince(
  db: D1Database,
  userId: string,
  since: Date,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_events
       WHERE subject_user_id = ?1 AND kind = 'share_created' AND at >= ?2`,
    )
    .bind(userId, since.toISOString())
    .first<{ n: number }>();
  return row?.n ?? 0;
}
