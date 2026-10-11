// Legal holds: copies of a share, its conversation, its owner and their
// sessions, preserved for law enforcement in `legal_holds` and
// `legal_hold_items`. Neither table has a foreign key to shares, trees or
// users, so revoking, deleting the conversation or deleting the account
// leaves the copies; only `releaseHold` removes them. No API route returns
// the copies; the admin review page shows a held snapshot (`heldSnapshot`),
// and the operator reads the rest with `wrangler d1 execute`
// (docs/runbooks/csam.md).
import { ConflictError, NotFoundError } from '@tangent/core';
import type {
  AdminHold,
  HoldReportKind,
  LegalHoldReason,
  SharePayload,
  TreeBackup,
} from '@tangent/shared';
import { userIdOfAccount } from '../auth/account.js';
import { createD1Repositories, splitSnapshot } from '../db/d1-repositories.js';
import type { SqlRow } from '../db/rows.js';
import type { auditEvents, authUsers, legalHoldItems, legalHolds, shares } from '../db/schema.js';
import { auditStatement } from './audit.js';

type HoldRow = SqlRow<typeof legalHolds>;
type HeldKind = SqlRow<typeof legalHoldItems>['kind'];

/**
 * How long a hold is kept after it was reported outside Tangent: US law
 * (18 U.S.C. §2258A(h)) has a provider preserve what it reported to NCMEC for
 * a year.
 */
const REPORTED_HOLD_MS = 365 * 86_400_000;

/** The columns of a session worth keeping: never its token, which would sign the user in. */
const SESSION_COLUMNS = 'id, user_id, ip_address, user_agent, created_at, updated_at, expires_at';

export interface PlaceHold {
  reason: LegalHoldReason;
  /** An admin, or the system (a screening or report rule). */
  actor: 'admin' | 'system';
  /** The admin's user id; null for the system and the dev bypass. */
  createdBy: string | null;
  /** The share whose content is held. */
  shareId: string;
  /** The share's tree and owner, when the share row may not exist (a publish refused by screening). */
  treeId?: string;
  ownerAccountId?: string;
  /** The content to hold when no snapshot is stored yet. */
  payload?: SharePayload;
  reportId?: string | null;
  notes?: string | null;
}

/**
 * Copies a share's evidence into a new hold, in one batch with its audit
 * row: the share row, its snapshot (or `payload`), a backup of its whole
 * conversation, the owner's user row and their sessions' addresses and
 * browsers. Each copy is JSON in chunks of `share_snapshots`' size. An
 * unreleased hold of the same share for the same reason is returned instead
 * (`created` false), so a retry or a second report adds nothing.
 */
export async function placeHold(
  db: D1Database,
  input: PlaceHold,
  now = new Date(),
): Promise<{ holdId: string; created: boolean }> {
  const existing = await db
    .prepare(
      `SELECT id FROM legal_holds
       WHERE share_id = ?1 AND reason = ?2 AND released_at IS NULL
       ORDER BY created_at LIMIT 1`,
    )
    .bind(input.shareId, input.reason)
    .first<Pick<HoldRow, 'id'>>();
  if (existing) return { holdId: existing.id, created: false };

  const repos = createD1Repositories(db);
  const share = await db
    .prepare('SELECT * FROM shares WHERE id = ?')
    .bind(input.shareId)
    .first<SqlRow<typeof shares>>();
  const treeId = input.treeId ?? share?.tree_id ?? null;
  const ownerAccountId = input.ownerAccountId ?? share?.account_id ?? null;
  if (!share && !(treeId && ownerAccountId)) throw new NotFoundError('Share');
  const userId = ownerAccountId ? userIdOfAccount(ownerAccountId) : null;

  const [snapshot, backup, user, sessions] = await Promise.all([
    input.payload
      ? Promise.resolve(JSON.stringify(input.payload))
      : repos.shares.getSnapshot(input.shareId),
    treeId ? treeBackup(db, treeId, now) : Promise.resolve(null),
    userId
      ? db
          .prepare('SELECT * FROM auth_users WHERE id = ?')
          .bind(userId)
          .first<SqlRow<typeof authUsers>>()
      : Promise.resolve(null),
    userId
      ? db
          .prepare(`SELECT ${SESSION_COLUMNS} FROM auth_sessions WHERE user_id = ?`)
          .bind(userId)
          .all()
          .then((r) => r.results)
      : Promise.resolve([]),
  ]);

  const holdId = crypto.randomUUID();
  const items: [HeldKind, string | null][] = [
    ['share', share ? JSON.stringify(share) : null],
    ['snapshot', snapshot],
    ['tree_backup', backup ? JSON.stringify(backup) : null],
    ['user', user ? JSON.stringify(user) : null],
    ['sessions', JSON.stringify(sessions)],
  ];

  await db.batch([
    db
      .prepare(
        `INSERT INTO legal_holds
           (id, reason, report_id, share_id, subject_user_id, subject_email, created_at, created_by, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        holdId,
        input.reason,
        input.reportId ?? null,
        input.shareId,
        userId,
        user?.email ?? null,
        now.toISOString(),
        input.createdBy,
        input.notes ?? null,
      ),
    ...items.flatMap(([kind, json]) =>
      json === null
        ? []
        : splitSnapshot(json).map((data, chunk) =>
            db
              .prepare(
                'INSERT INTO legal_hold_items (hold_id, kind, chunk, data) VALUES (?1, ?2, ?3, ?4)',
              )
              .bind(holdId, kind, chunk, data),
          ),
    ),
    auditStatement(
      db,
      {
        kind: 'hold_placed',
        actor: input.actor,
        actorUserId: input.createdBy,
        subjectUserId: userId,
        shareId: input.shareId,
        reportId: input.reportId ?? null,
        holdId,
        data: {
          reason: input.reason,
          held: items.filter(([, json]) => json !== null).map(([kind]) => kind),
        },
      },
      now,
    ),
  ]);
  return { holdId, created: true };
}

/** The tree as a JSON backup would have it, or null when it is gone. */
async function treeBackup(db: D1Database, treeId: string, now: Date): Promise<TreeBackup | null> {
  const trees = createD1Repositories(db).trees;
  const tree = await trees.getTree(treeId);
  if (!tree) return null;
  const [branches, nodes, links] = await Promise.all([
    trees.listBranches(treeId),
    trees.listNodes(treeId),
    trees.listLinks(treeId),
  ]);
  return {
    format: 'tangent-tree-backup',
    version: 1,
    exportedAt: now.toISOString(),
    tree,
    branches,
    nodes,
    links,
  };
}

/**
 * Releases a hold: deletes its copies and keeps the hold's record, in one
 * batch with the audit row. Refused (409) within a year of the hold's latest
 * report outside Tangent; releasing a released hold changes nothing.
 */
export async function releaseHold(
  db: D1Database,
  holdId: string,
  releasedBy: string | null,
  notes: string | null,
  now = new Date(),
): Promise<void> {
  const hold = await getHoldRow(db, holdId);
  if (hold.released_at) return;
  const reports = await externalReports(db, [holdId]);
  const last = reports.get(holdId)?.at(-1);
  if (last && now.getTime() - Date.parse(last.at) < REPORTED_HOLD_MS) {
    throw new ConflictError(
      `This hold was reported on ${last.at.slice(0, 10)} and must be kept for a year after that.`,
    );
  }
  await db.batch([
    db
      .prepare(
        `UPDATE legal_holds SET released_at = ?2, released_by = ?3,
           notes = CASE WHEN ?4 IS NULL THEN notes ELSE coalesce(notes || char(10), '') || ?4 END
         WHERE id = ?1 AND released_at IS NULL`,
      )
      .bind(holdId, now.toISOString(), releasedBy, notes),
    db.prepare('DELETE FROM legal_hold_items WHERE hold_id = ?').bind(holdId),
    auditStatement(
      db,
      {
        kind: 'hold_released',
        actor: 'admin',
        actorUserId: releasedBy,
        subjectUserId: hold.subject_user_id,
        shareId: hold.share_id,
        reportId: hold.report_id,
        holdId,
        data: {},
      },
      now,
    ),
  ]);
}

/** Records that the hold was reported outside Tangent (the report is filed by hand). */
export async function recordHoldReport(
  db: D1Database,
  holdId: string,
  adminId: string | null,
  report: { kind: HoldReportKind; reference: string },
  now = new Date(),
): Promise<void> {
  const hold = await getHoldRow(db, holdId);
  await auditStatement(
    db,
    {
      kind: 'hold_reported',
      actor: 'admin',
      actorUserId: adminId,
      subjectUserId: hold.subject_user_id,
      shareId: hold.share_id,
      reportId: hold.report_id,
      holdId,
      data: report,
    },
    now,
  ).run();
}

/**
 * The conversation an unreleased hold of the share kept (the newest that kept
 * one), as stored JSON, or null. The one read of a held copy, for the admin
 * review page (http/review-page.ts) once the share itself is gone.
 */
export async function heldSnapshot(db: D1Database, shareId: string): Promise<string | null> {
  const { results } = await db
    .prepare(
      `SELECT data FROM legal_hold_items
       WHERE kind = 'snapshot' AND hold_id = (
         SELECT h.id FROM legal_holds h
         WHERE h.share_id = ?1 AND h.released_at IS NULL
           AND EXISTS (SELECT 1 FROM legal_hold_items i WHERE i.hold_id = h.id AND i.kind = 'snapshot')
         ORDER BY h.created_at DESC, h.id DESC LIMIT 1)
       ORDER BY chunk`,
    )
    .bind(shareId)
    .all<Pick<SqlRow<typeof legalHoldItems>, 'data'>>();
  return results.length > 0 ? results.map((r) => r.data).join('') : null;
}

/** One hold's metadata. */
export async function getHold(db: D1Database, holdId: string): Promise<AdminHold> {
  const row = await getHoldRow(db, holdId);
  return toAdminHold(row, (await externalReports(db, [holdId])).get(holdId) ?? []);
}

/** Every hold's metadata, newest first. */
export async function listHolds(db: D1Database): Promise<AdminHold[]> {
  const { results } = await db
    .prepare('SELECT * FROM legal_holds ORDER BY created_at DESC, id DESC')
    .all<HoldRow>();
  const reports = await externalReports(
    db,
    results.map((r) => r.id),
  );
  return results.map((r) => toAdminHold(r, reports.get(r.id) ?? []));
}

async function getHoldRow(db: D1Database, holdId: string): Promise<HoldRow> {
  const row = await db
    .prepare('SELECT * FROM legal_holds WHERE id = ?')
    .bind(holdId)
    .first<HoldRow>();
  if (!row) throw new NotFoundError('Hold');
  return row;
}

type HoldReport = AdminHold['externalReports'][number];

/** The `hold_reported` audit rows of these holds, oldest first, by hold. */
async function externalReports(
  db: D1Database,
  holdIds: readonly string[],
): Promise<Map<string, HoldReport[]>> {
  const out = new Map<string, HoldReport[]>();
  if (holdIds.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT hold_id, at, data FROM audit_events
       WHERE kind = 'hold_reported' AND hold_id IN (SELECT value FROM json_each(?1))
       ORDER BY at`,
    )
    .bind(JSON.stringify(holdIds))
    .all<Pick<SqlRow<typeof auditEvents>, 'hold_id' | 'at' | 'data'>>();
  for (const r of results) {
    if (!r.hold_id || !r.data) continue;
    const { kind, reference } = JSON.parse(r.data) as Pick<HoldReport, 'kind' | 'reference'>;
    out.set(r.hold_id, [...(out.get(r.hold_id) ?? []), { kind, reference, at: r.at }]);
  }
  return out;
}

function toAdminHold(row: HoldRow, externalReports: HoldReport[]): AdminHold {
  return {
    id: row.id,
    reason: row.reason,
    reportId: row.report_id,
    shareId: row.share_id,
    subjectUserId: row.subject_user_id,
    subjectEmail: row.subject_email,
    createdAt: row.created_at,
    createdBy: row.created_by,
    releasedAt: row.released_at,
    releasedBy: row.released_by,
    notes: row.notes,
    externalReports,
  };
}
