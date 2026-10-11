// The admin side of reports (src/share/review.ts, src/routes/admin-moderation.ts,
// src/http/review-page.ts): the queue, what Remove, Restore and Reject do to
// the share, its reports and its owner's strikes, the audit trail, and the
// page an admin reads a reported conversation on.
import type {
  AdminReport,
  AdminReportsResponse,
  AdminUser,
  AdminUserEventsResponse,
  AdminUsersResponse,
  MeResponse,
  ReportCategory,
  ShareSummary,
  TreeDetail,
} from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AppEnv } from '../src/env.js';
import { fileReport } from '../src/share/reports.js';
import { makeNode } from './fixtures.js';
import { BASE, ok } from './http.js';
import { authEnv, client } from './session-client.js';

let emailSeq = 0;
async function newUser(e: AppEnv) {
  const c = client(e);
  const email = `mod${++emailSeq}-${Math.random().toString(36).slice(2, 8)}@example.org`;
  await c.signIn(email);
  const me = await ok<MeResponse>(await c.call('/api/me'));
  return { ...c, email, id: me.userId! };
}
type User = Awaited<ReturnType<typeof newUser>>;

/** An admin and a user who publishes; `e` lists the admin. */
async function setup() {
  const signup = authEnv({ SHARING: 'everyone', SHARE_MIN_ACCOUNT_AGE_MS: '0' });
  const admin = await newUser(signup);
  const owner = await newUser(signup);
  const e = authEnv({
    SHARING: 'everyone',
    SHARE_MIN_ACCOUNT_AGE_MS: '0',
    ADMIN_USER_IDS: admin.id,
  });
  const as =
    (u: User) =>
    (path: string, init: Parameters<User['call']>[1] = {}) =>
      u.call(path, init, e);
  return { e, admin, owner, asAdmin: as(admin), asOwner: as(owner) };
}

/** A link of `user`'s to a conversation whose question is `marker`. */
async function publish(user: User, e: AppEnv, marker: string): Promise<ShareSummary> {
  const detail = await ok<TreeDetail>(
    await user.call('/api/trees', { method: 'POST', json: { title: 'Shared' } }, e),
    201,
  );
  const trunk = detail.branches[0]!;
  const q = makeNode(trunk, 0, null, { role: 'user', content: marker });
  const a = makeNode(trunk, 1, q.id, { role: 'assistant', content: 'An answer' });
  await createD1Repositories(env.DB).trees.appendNodes([q, a], new Date().toISOString());
  return ok<ShareSummary>(
    await user.call(
      '/api/shares',
      { method: 'POST', json: { treeId: detail.tree.id, scope: 'tree' } },
      e,
    ),
    201,
  );
}

let reporterSeq = 0;
/** A report from a new reporter each time, as the share page files it. */
async function report(
  e: AppEnv,
  shareId: string,
  category: ReportCategory,
  at = new Date(),
): Promise<string> {
  const share = await createD1Repositories(env.DB).shares.getShare(shareId);
  const { reportId } = await fileReport(
    e,
    BASE,
    {
      share: share!,
      category,
      details: `Reported as ${category}`,
      reporterEmail: 'reporter@example.org',
      reporterKey: `n:reporter-${++reporterSeq}`,
      reporterUserId: null,
    },
    at,
  );
  return reportId;
}

async function takedownOf(shareId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT takedown FROM shares WHERE id = ?')
    .bind(shareId)
    .first<{ takedown: string | null }>();
  return row?.takedown ?? null;
}

async function auditKinds(shareId: string, kinds: string[]): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT kind, data FROM audit_events
     WHERE share_id = ?1 AND kind IN (SELECT value FROM json_each(?2)) ORDER BY at, rowid`,
  )
    .bind(shareId, JSON.stringify(kinds))
    .all<{ kind: string; data: string }>();
  return results.map((r) => `${r.kind} ${r.data}`);
}

async function allReports(asAdmin: AsAdmin, shareId: string) {
  const { reports } = await ok<AdminReportsResponse>(
    await asAdmin('/api/admin/reports?status=all'),
  );
  return reports.filter((r) => r.shareId === shareId);
}

type AsAdmin = Awaited<ReturnType<typeof setup>>['asAdmin'];

/** The user as the admin list shows them. */
async function adminUser(asAdmin: AsAdmin, email: string): Promise<AdminUser> {
  const { users } = await ok<AdminUsersResponse>(
    await asAdmin(`/api/admin/users?q=${encodeURIComponent(email)}`),
  );
  return users[0]!;
}

function resolve(
  asAdmin: AsAdmin,
  reportId: string,
  action: 'remove' | 'restore' | 'reject',
  notes?: string,
) {
  return ok<AdminReport>(
    asAdmin(`/api/admin/reports/${reportId}/resolve`, {
      method: 'POST',
      json: { action, ...(notes ? { notes } : {}) },
    }),
  );
}

describe('the report queue', () => {
  it('lists undecided reports oldest first, with the share, its owner and how many reported it', async () => {
    const { e, owner, asAdmin } = await setup();
    const share = await publish(owner, e, 'QUEUED-QUESTION');
    const first = await report(e, share.id, 'other', new Date(Date.now() - 2_000));
    const second = await report(e, share.id, 'csam', new Date(Date.now() - 1_000));

    const { reports } = await ok<AdminReportsResponse>(await asAdmin('/api/admin/reports'));
    const mine = reports.filter((r) => r.shareId === share.id);
    expect(mine.map((r) => r.id)).toEqual([first, second]);
    expect(mine[1]).toEqual({
      id: second,
      shareId: share.id,
      shareToken: share.token,
      ownerUserId: owner.id,
      ownerEmail: owner.email,
      category: 'csam',
      details: 'Reported as csam',
      reporterEmail: 'reporter@example.org',
      createdAt: expect.any(String) as string,
      resolution: 'pending',
      resolvedAt: null,
      resolvedBy: null,
      notes: null,
      shareState: 'pending_review',
      shareReporters: 2,
      held: true,
    });
    // Never the conversation itself.
    expect(JSON.stringify(reports)).not.toContain('QUEUED-QUESTION');

    // All of them, newest first, decided ones included.
    await resolve(asAdmin, first, 'reject');
    expect((await allReports(asAdmin, share.id)).map((r) => [r.id, r.resolution])).toEqual([
      [second, 'pending'],
      [first, 'rejected'],
    ]);
    const pending = await ok<AdminReportsResponse>(await asAdmin('/api/admin/reports'));
    expect(pending.reports.some((r) => r.id === first)).toBe(false);
    expect((await asAdmin('/api/admin/reports?cursor=bogus')).status).toBe(400);
    expect((await asAdmin('/api/admin/reports?status=open')).status).toBe(400);
  });

  it('pages with a cursor, in the order of each view', async () => {
    const { e, owner, asAdmin } = await setup();
    const share = await publish(owner, e, 'PAGED');
    // Before every other test's reports, so they lead the queue.
    const base = Date.parse('2001-01-01T00:00:00.000Z');
    const shareRow = await createD1Repositories(env.DB).shares.getShare(share.id);
    await env.DB.batch(
      Array.from({ length: 55 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO share_reports (id, share_id, share_token, owner_account_id, category, details, created_at)
           VALUES (?1, ?2, ?3, ?4, 'other', 'x', ?5)`,
        ).bind(
          `paged-${String(i).padStart(2, '0')}`,
          share.id,
          share.token,
          shareRow!.accountId,
          new Date(base + i * 1000).toISOString(),
        ),
      ),
    );
    const first = await ok<AdminReportsResponse>(await asAdmin('/api/admin/reports'));
    expect(first.reports).toHaveLength(50);
    expect(first.reports[0]!.id).toBe('paged-00');
    const next = await ok<AdminReportsResponse>(
      await asAdmin(`/api/admin/reports?cursor=${first.nextCursor!}`),
    );
    expect(next.reports.slice(0, 5).map((r) => r.id)).toEqual([
      'paged-50',
      'paged-51',
      'paged-52',
      'paged-53',
      'paged-54',
    ]);
  });
});

describe('deciding a report', () => {
  it('removes the share for good, acting on its other reports, and suspends at the second strike', async () => {
    const { e, admin, owner, asAdmin, asOwner } = await setup();
    const one = await publish(owner, e, 'FIRST');
    const two = await publish(owner, e, 'SECOND');
    const three = await publish(owner, e, 'THIRD');
    const a = await report(e, one.id, 'copyright');
    const b = await report(e, one.id, 'other');

    const removed = await resolve(asAdmin, a, 'remove', 'Pasted a book');
    expect(removed).toMatchObject({
      resolution: 'actioned',
      resolvedBy: admin.id,
      notes: 'Pasted a book',
      shareState: 'removed',
    });
    expect((await allReports(asAdmin, one.id)).map((r) => [r.id, r.resolution, r.notes])).toEqual(
      expect.arrayContaining([
        [a, 'actioned', 'Pasted a book'],
        [b, 'actioned', null],
      ]),
    );
    expect((await client(e).call(`/s/${one.token}`)).status).toBe(410);
    expect(await auditKinds(one.id, ['report_resolved', 'share_takedown'])).toEqual([
      'share_takedown {"takedown":"pending_review","version":1}',
      'share_takedown {"takedown":"removed","version":1}',
      'report_resolved {"action":"remove","resolution":"actioned"}',
      'report_resolved {"action":"remove","resolution":"actioned"}',
    ]);
    // One share, however many reports: one strike, so sharing goes on.
    expect(await adminUser(asAdmin, owner.email)).toMatchObject({
      sharingSuspended: false,
      removedShares: 1,
      openReports: 0,
    });
    expect((await client(e).call(`/s/${three.token}`)).status).toBe(200);

    // The second removed share suspends: nothing new is published and every link closes.
    await resolve(asAdmin, await report(e, two.id, 'other'), 'remove');
    expect((await client(e).call(`/s/${three.token}`)).status).toBe(404);
    expect((await ok<MeResponse>(await asOwner('/api/me'))).sharing).toBe(false);
    expect(await adminUser(asAdmin, owner.email)).toMatchObject({
      sharingSuspended: true,
      removedShares: 2,
    });
    const { events } = await ok<AdminUserEventsResponse>(
      await asAdmin(`/api/admin/users/${owner.id}/events`),
    );
    expect(events.find((ev) => ev.kind === 'sharing_suspended')).toMatchObject({
      actor: 'system',
      actorUserId: null,
      data: { suspended: true, strikes: 2 },
    });
  });

  it('restores a removed share, rejecting its reports so the strike goes', async () => {
    const { e, owner, asAdmin } = await setup();
    const one = await publish(owner, e, 'ONE');
    const two = await publish(owner, e, 'TWO');
    const a = await report(e, one.id, 'violent_or_illegal');
    await resolve(asAdmin, a, 'remove');

    const restored = await resolve(asAdmin, a, 'restore', 'A history lesson');
    expect(restored).toMatchObject({ resolution: 'rejected', shareState: 'active' });
    expect((await client(e).call(`/s/${one.token}`)).status).toBe(200);
    // Its strike is gone, so another removal is the first strike again.
    await resolve(asAdmin, await report(e, two.id, 'other'), 'remove');
    expect(await adminUser(asAdmin, owner.email)).toMatchObject({
      sharingSuspended: false,
      removedShares: 1,
    });
    expect(await auditKinds(one.id, ['report_resolved'])).toEqual([
      'report_resolved {"action":"remove","resolution":"actioned"}',
      'report_resolved {"action":"restore","resolution":"rejected"}',
    ]);
  });

  it('rejects one report, putting the share back up only when no other pending report keeps it down', async () => {
    const { e, owner, asAdmin } = await setup();
    const share = await publish(owner, e, 'DISPUTED');
    // Two reporters of defamation take it down; rejecting one leaves too few.
    const a = await report(e, share.id, 'defamation');
    const b = await report(e, share.id, 'defamation');
    const c = await report(e, share.id, 'other');
    expect(await takedownOf(share.id)).toBe('pending_review');
    expect(await resolve(asAdmin, a, 'reject')).toMatchObject({
      resolution: 'rejected',
      shareState: 'active',
    });
    expect(await takedownOf(share.id)).toBeNull();
    expect((await allReports(asAdmin, share.id)).find((r) => r.id === b)!.resolution).toBe(
      'pending',
    );

    // A copyright report keeps it down whatever else is rejected.
    const d = await report(e, share.id, 'copyright');
    await resolve(asAdmin, c, 'reject');
    await resolve(asAdmin, b, 'reject');
    expect(await takedownOf(share.id)).toBe('pending_review');
    await resolve(asAdmin, d, 'reject');
    expect(await takedownOf(share.id)).toBeNull();

    // Rejecting leaves a removal alone.
    await resolve(asAdmin, await report(e, share.id, 'other'), 'remove');
    await resolve(asAdmin, a, 'reject');
    expect(await takedownOf(share.id)).toBe('removed');

    expect(
      (
        await asAdmin('/api/admin/reports/nope/resolve', {
          method: 'POST',
          json: { action: 'reject' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await asAdmin(`/api/admin/reports/${a}/resolve`, {
          method: 'POST',
          json: { action: 'delete' },
        })
      ).status,
    ).toBe(400);
  });
});

describe('suspending sharing by hand', () => {
  it('closes the links, records who did it, and lifts', async () => {
    const { e, admin, owner, asAdmin, asOwner } = await setup();
    const share = await publish(owner, e, 'SUSPENDED');
    const patch = (sharingSuspended: boolean) =>
      ok<AdminUser>(
        asAdmin(`/api/admin/users/${owner.id}`, { method: 'PATCH', json: { sharingSuspended } }),
      );
    expect(await patch(true)).toMatchObject({ sharingSuspended: true });
    expect((await client(e).call(`/s/${share.token}`)).status).toBe(404);
    expect((await ok<MeResponse>(await asOwner('/api/me'))).sharing).toBe(false);
    expect(await patch(false)).toMatchObject({ sharingSuspended: false });
    expect((await client(e).call(`/s/${share.token}`)).status).toBe(200);

    const { events, nextCursor } = await ok<AdminUserEventsResponse>(
      await asAdmin(`/api/admin/users/${owner.id}/events`),
    );
    expect(nextCursor).toBeNull();
    // The two suspensions, newest first, then the publish (its two rows may share a millisecond).
    const rows = events.map((ev) => [ev.kind, ev.actor, ev.actorUserId, ev.data]);
    expect(rows.slice(0, 2)).toEqual([
      ['sharing_suspended', 'admin', admin.id, { suspended: false }],
      ['sharing_suspended', 'admin', admin.id, { suspended: true }],
    ]);
    expect(rows.slice(2)).toEqual(
      expect.arrayContaining([
        ['share_created', 'user', owner.id, { version: 1, scope: 'tree' }],
        ['share_screened', 'system', null, expect.objectContaining({ verdict: 'allow' })],
      ]),
    );
    expect(rows).toHaveLength(4);
  });

  it('pages the audit trail, newest first', async () => {
    const { owner, asAdmin } = await setup();
    const base = Date.parse('2002-01-01T00:00:00.000Z');
    await env.DB.batch(
      Array.from({ length: 52 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO audit_events (id, at, kind, actor, subject_user_id, data)
           VALUES (?1, ?2, 'share_reviewed', 'admin', ?3, '{}')`,
        ).bind(`ev-${i}`, new Date(base + i * 1000).toISOString(), owner.id),
      ),
    );
    const first = await ok<AdminUserEventsResponse>(
      await asAdmin(`/api/admin/users/${owner.id}/events`),
    );
    expect(first.events).toHaveLength(50);
    const next = await ok<AdminUserEventsResponse>(
      await asAdmin(`/api/admin/users/${owner.id}/events?cursor=${first.nextCursor!}`),
    );
    expect(next.events.map((ev) => ev.id)).toEqual(['ev-1', 'ev-0']);
    expect(next.nextCursor).toBeNull();
  });
});

describe('the review page', () => {
  it("shows an admin the share's snapshot, uncached and out of search, and records the view", async () => {
    const { e, admin, owner, asAdmin, asOwner } = await setup();
    const share = await publish(owner, e, 'REVIEWED-QUESTION');
    await report(e, share.id, 'copyright');

    // Taken down, it still shows: the admin is deciding on it.
    const res = await asAdmin(`/admin/review/${share.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('REVIEWED-QUESTION');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"');

    for (const as of [asOwner, (path: string) => client(e).call(path)]) {
      const denied = await as(`/admin/review/${share.id}`);
      expect(denied.status).toBe(404);
      expect(await denied.text()).not.toContain('REVIEWED-QUESTION');
    }
    expect((await asAdmin('/admin/review/nope')).status).toBe(404);

    const { results } = await env.DB.prepare(
      `SELECT actor_user_id, subject_user_id, data FROM audit_events
       WHERE share_id = ? AND kind = 'share_reviewed'`,
    )
      .bind(share.id)
      .all();
    expect(results).toEqual([
      { actor_user_id: admin.id, subject_user_id: owner.id, data: '{"source":"share"}' },
    ]);
  });

  it("shows a held copy once the share is gone, and nothing when there's none", async () => {
    const { e, owner, asAdmin, asOwner } = await setup();
    const held = await publish(owner, e, 'HELD-COPY');
    const unheld = await publish(owner, e, 'NOT-HELD');
    // A CSAM report places a hold; the owner then deletes the share.
    await report(e, held.id, 'csam');
    expect((await asOwner(`/api/shares/${held.id}`, { method: 'DELETE' })).status).toBe(204);
    const res = await asAdmin(`/admin/review/${held.id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('HELD-COPY');

    await ok(await asOwner(`/api/shares/${unheld.id}/revoke`, { method: 'POST' }));
    expect((await asAdmin(`/admin/review/${unheld.id}`)).status).toBe(404);
  });
});
