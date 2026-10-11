import { NotFoundError } from '@tangent/core';
import {
  ADMIN_MODERATION_PAGE,
  API_ROUTES,
  type AdminAuditEvent,
  type AdminHold,
  type AdminHoldsResponse,
  type AdminReport,
  type AdminReportsResponse,
  type AdminShare,
  type AdminUserEventsResponse,
} from '@tangent/shared';
import { Hono, type Context } from 'hono';
import { createD1Repositories } from '../db/d1-repositories.js';
import type { SqlRow } from '../db/rows.js';
import type { auditEvents } from '../db/schema.js';
import type { AppBindings } from '../env.js';
import { decodeCursor, encodeCursor } from '../http/cursor.js';
import { validateJson, validateQuery } from '../http/errors.js';
import { shareService } from '../registries.js';
import {
  getHold,
  listHolds,
  placeHold,
  recordHoldReport,
  releaseHold,
} from '../share/legal-hold.js';
import { listReports, removeShare, resolveReport, restoreShare } from '../share/review.js';

type AuditRow = SqlRow<typeof auditEvents>;

/**
 * Reports, takedowns, legal holds and the audit trail, mounted by
 * `adminRoutes` behind its admins-only check. The decisions are in
 * share/review.ts. Every reply is metadata: a report's own words, never the
 * conversation, and a hold's record, never its copies. The conversation is
 * shown only on the review page (http/review-page.ts), so a stolen admin
 * session can't script its way through the content.
 */
export function adminModerationRoutes(): Hono<AppBindings> {
  const r = new Hono<AppBindings>();

  r.get('/reports', validateQuery(API_ROUTES.adminReports), async (c) =>
    c.json((await listReports(c.env.DB, c.req.valid('query'))) satisfies AdminReportsResponse),
  );

  r.post('/reports/:reportId/resolve', validateJson(API_ROUTES.adminResolveReport), async (c) => {
    const { action, notes } = c.req.valid('json');
    const report = await resolveReport(c.env.DB, c.req.param('reportId'), action, {
      adminId: c.var.identity.userId,
      notes: notes || null,
    });
    return c.json(report satisfies AdminReport);
  });

  // A takedown without a report, or after a notice that came another way (docs/LEGAL.md §8).
  r.post('/shares/:shareId/remove', async (c) => {
    const share = await requireShare(c.env.DB, c.req.param('shareId'));
    await removeShare(c.env.DB, share, { adminId: c.var.identity.userId });
    return c.json((await adminShare(c, share.id, share.accountId)) satisfies AdminShare);
  });

  r.post('/shares/:shareId/restore', async (c) => {
    const share = await requireShare(c.env.DB, c.req.param('shareId'));
    await restoreShare(c.env.DB, share, { adminId: c.var.identity.userId });
    return c.json((await adminShare(c, share.id, share.accountId)) satisfies AdminShare);
  });

  // Events about the user, kept after their account is deleted, so no 404 for an unknown id.
  r.get('/users/:userId/events', validateQuery(API_ROUTES.adminUserEvents), async (c) => {
    const { cursor } = c.req.valid('query');
    const params: (string | number)[] = [c.req.param('userId')];
    let after = '';
    if (cursor) {
      const { at, id } = decodeCursor(cursor);
      params.push(new Date(at).toISOString(), id);
      after = 'AND (at < ?2 OR (at = ?2 AND id < ?3))';
    }
    params.push(ADMIN_MODERATION_PAGE + 1);
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM audit_events WHERE subject_user_id = ?1 ${after}
       ORDER BY at DESC, id DESC LIMIT ?${params.length}`,
    )
      .bind(...params)
      .all<AuditRow>();
    const page = results.slice(0, ADMIN_MODERATION_PAGE);
    const last = page.at(-1);
    return c.json({
      events: page.map(toAdminAuditEvent),
      nextCursor:
        results.length > ADMIN_MODERATION_PAGE && last
          ? encodeCursor(Date.parse(last.at), last.id)
          : null,
    } satisfies AdminUserEventsResponse);
  });

  r.get('/holds', async (c) =>
    c.json({ holds: await listHolds(c.env.DB) } satisfies AdminHoldsResponse),
  );

  r.post('/shares/:shareId/hold', validateJson(API_ROUTES.adminPlaceHold), async (c) => {
    const { reason, notes } = c.req.valid('json');
    const { holdId } = await placeHold(c.env.DB, {
      reason,
      actor: 'admin',
      createdBy: c.var.identity.userId,
      shareId: c.req.param('shareId'),
      notes: notes || null,
    });
    return c.json((await getHold(c.env.DB, holdId)) satisfies AdminHold);
  });

  r.post('/holds/:holdId/release', validateJson(API_ROUTES.adminReleaseHold), async (c) => {
    const holdId = c.req.param('holdId');
    const { notes } = c.req.valid('json');
    await releaseHold(c.env.DB, holdId, c.var.identity.userId, notes || null);
    return c.json((await getHold(c.env.DB, holdId)) satisfies AdminHold);
  });

  r.post('/holds/:holdId/external-report', validateJson(API_ROUTES.adminReportHold), async (c) => {
    const holdId = c.req.param('holdId');
    await recordHoldReport(c.env.DB, holdId, c.var.identity.userId, c.req.valid('json'));
    return c.json((await getHold(c.env.DB, holdId)) satisfies AdminHold);
  });

  return r;
}

async function requireShare(db: D1Database, shareId: string) {
  const share = await createD1Repositories(db).shares.getShare(shareId);
  if (!share) throw new NotFoundError('Share');
  return share;
}

/** The share as its owner's list has it, with its takedown. */
async function adminShare(
  c: Context<AppBindings>,
  shareId: string,
  accountId: string,
): Promise<AdminShare> {
  const [summary, share] = await Promise.all([
    shareService(c.env, c.req.url, accountId).get(shareId),
    createD1Repositories(c.env.DB).shares.getShare(shareId),
  ]);
  return { ...summary, takedown: share?.takedown ?? null };
}

function toAdminAuditEvent(row: AuditRow): AdminAuditEvent {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    actor: row.actor,
    actorUserId: row.actor_user_id,
    shareId: row.share_id,
    reportId: row.report_id,
    holdId: row.hold_id,
    data: row.data ? (JSON.parse(row.data) as Record<string, unknown>) : null,
  };
}
