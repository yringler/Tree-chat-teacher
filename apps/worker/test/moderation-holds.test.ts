// Legal holds: what a hold copies, that nothing an owner does removes it,
// that only metadata ever leaves through the admin API, and when it may be
// released.
import type {
  AdminHold,
  AdminHoldsResponse,
  MeResponse,
  ShareSummary,
  TreeDetail,
} from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AppEnv } from '../src/env.js';
import { releaseHold } from '../src/share/legal-hold.js';
import { makeNode } from './fixtures.js';
import { ok } from './http.js';
import { authEnv, client } from './session-client.js';

// @ts-expect-error -- `import.meta.glob` is Vite's; the worker tsconfig has no vite/client types.
const SOURCES = import.meta.glob('../src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const HELD = 'HELD-QUESTION';

let emailSeq = 0;
async function newUser(e: AppEnv) {
  const c = client(e);
  const email = `hold${++emailSeq}-${Math.random().toString(36).slice(2, 8)}@example.org`;
  await c.signIn(email);
  const me = await ok<MeResponse>(await c.call('/api/me'));
  return { ...c, email, id: me.userId! };
}

/** An admin, and a user with a tree holding `HELD` and a share link of it. */
async function setup() {
  const signup = authEnv({ SHARING: 'everyone' });
  const admin = await newUser(signup);
  const user = await newUser(signup);
  const e = authEnv({ SHARING: 'everyone', ADMIN_USER_IDS: admin.id });
  const detail = await ok<TreeDetail>(
    await user.call('/api/trees', { method: 'POST', json: { title: 'Held tree' } }, e),
    201,
  );
  const trunk = detail.branches[0]!;
  const q = makeNode(trunk, 0, null, { role: 'user', content: HELD });
  const a = makeNode(trunk, 1, q.id, { role: 'assistant', content: 'An answer' });
  await createD1Repositories(env.DB).trees.appendNodes([q, a], new Date().toISOString());
  const share = await ok<ShareSummary>(
    await user.call(
      '/api/shares',
      { method: 'POST', json: { treeId: detail.tree.id, scope: 'tree' } },
      e,
    ),
    201,
  );
  const asAdmin = (path: string, init: Parameters<typeof admin.call>[1] = {}) =>
    admin.call(path, init, e);
  const asUser = (path: string, init: Parameters<typeof user.call>[1] = {}) =>
    user.call(path, init, e);
  return { e, admin, user, asAdmin, asUser, treeId: detail.tree.id, share };
}

async function items(holdId: string): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    'SELECT kind, data FROM legal_hold_items WHERE hold_id = ? ORDER BY kind, chunk',
  )
    .bind(holdId)
    .all<{ kind: string; data: string }>();
  const out: Record<string, string> = {};
  for (const r of results) out[r.kind] = (out[r.kind] ?? '') + r.data;
  return out;
}

async function auditKinds(holdId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT kind FROM audit_events WHERE hold_id = ? ORDER BY at, rowid',
  )
    .bind(holdId)
    .all<{ kind: string }>();
  return results.map((r) => r.kind);
}

describe('legal holds', () => {
  it('copies the share, its conversation, the owner and their sessions; once per share and reason', async () => {
    const { admin, user, asAdmin, share } = await setup();
    const hold = await ok<AdminHold>(
      await asAdmin(`/api/admin/shares/${share.id}/hold`, {
        method: 'POST',
        json: { reason: 'csam', notes: 'Seen in report' },
      }),
    );
    expect(hold).toMatchObject({
      reason: 'csam',
      shareId: share.id,
      subjectUserId: user.id,
      subjectEmail: user.email,
      createdBy: admin.id,
      releasedAt: null,
      notes: 'Seen in report',
      externalReports: [],
    });

    const held = await items(hold.id);
    expect(Object.keys(held).sort()).toEqual([
      'sessions',
      'share',
      'snapshot',
      'tree_backup',
      'user',
    ]);
    expect(held['snapshot']).toContain(HELD);
    expect(held['tree_backup']).toContain(HELD);
    expect(JSON.parse(held['share']!)).toMatchObject({ id: share.id, token: share.token });
    expect(JSON.parse(held['user']!)).toMatchObject({ id: user.id, email: user.email });
    const sessions = JSON.parse(held['sessions']!) as { user_id: string }[];
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.user_id === user.id)).toBe(true);
    // Never a session's token, which would sign the user in.
    const { results: tokens } = await env.DB.prepare(
      'SELECT token FROM auth_sessions WHERE user_id = ?',
    )
      .bind(user.id)
      .all<{ token: string }>();
    for (const { token } of tokens) expect(held['sessions']).not.toContain(token);

    const again = await ok<AdminHold>(
      await asAdmin(`/api/admin/shares/${share.id}/hold`, {
        method: 'POST',
        json: { reason: 'csam' },
      }),
    );
    expect(again.id).toBe(hold.id);
    const other = await ok<AdminHold>(
      await asAdmin(`/api/admin/shares/${share.id}/hold`, {
        method: 'POST',
        json: { reason: 'law_enforcement' },
      }),
    );
    expect(other.id).not.toBe(hold.id);
    expect(await auditKinds(hold.id)).toEqual(['hold_placed']);
    expect(
      (await asAdmin('/api/admin/shares/nope/hold', { method: 'POST', json: { reason: 'other' } }))
        .status,
    ).toBe(404);
  });

  it('survives revoking, deleting the share and the tree, and deleting the account', async () => {
    const { user, asAdmin, asUser, share, treeId } = await setup();
    const hold = await ok<AdminHold>(
      await asAdmin(`/api/admin/shares/${share.id}/hold`, {
        method: 'POST',
        json: { reason: 'violent_or_illegal' },
      }),
    );
    const before = await items(hold.id);

    await ok(await asUser(`/api/shares/${share.id}/revoke`, { method: 'POST' }));
    expect((await asUser(`/api/shares/${share.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await asUser(`/api/trees/${treeId}`, { method: 'DELETE' })).status).toBe(204);
    expect(
      (await asUser('/api/account', { method: 'DELETE', json: { confirmEmail: user.email } }))
        .status,
    ).toBe(204);

    expect(
      await env.DB.prepare('SELECT 1 FROM auth_users WHERE id = ?').bind(user.id).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT 1 FROM trees WHERE id = ?').bind(treeId).first(),
    ).toBeNull();
    expect(await items(hold.id)).toEqual(before);
    const { holds } = await ok<AdminHoldsResponse>(await asAdmin('/api/admin/holds'));
    expect(holds.find((h) => h.id === hold.id)).toMatchObject({
      subjectUserId: user.id,
      subjectEmail: user.email,
      releasedAt: null,
    });
    // The share's audit trail outlives it too.
    const { results } = await env.DB.prepare(
      'SELECT kind FROM audit_events WHERE share_id = ? ORDER BY at, rowid',
    )
      .bind(share.id)
      .all<{ kind: string }>();
    expect(results.map((r) => r.kind)).toEqual([
      'share_screened',
      'share_created',
      'hold_placed',
      'share_revoked',
      'share_deleted',
    ]);
  });

  it('keeps a reported hold a year, then releases it: copies gone, record kept', async () => {
    const { asAdmin, share } = await setup();
    const hold = await ok<AdminHold>(
      await asAdmin(`/api/admin/shares/${share.id}/hold`, {
        method: 'POST',
        json: { reason: 'csam' },
      }),
    );
    const reported = await ok<AdminHold>(
      await asAdmin(`/api/admin/holds/${hold.id}/external-report`, {
        method: 'POST',
        json: { kind: 'ncmec', reference: 'CT-123' },
      }),
    );
    expect(reported.externalReports).toEqual([
      { kind: 'ncmec', reference: 'CT-123', at: expect.any(String) as string },
    ]);

    const early = await asAdmin(`/api/admin/holds/${hold.id}/release`, {
      method: 'POST',
      json: {},
    });
    expect(early.status).toBe(409);
    expect(Object.keys(await items(hold.id)).length).toBe(5);

    const later = new Date(Date.now() + 366 * 86_400_000);
    await releaseHold(env.DB, hold.id, 'admin-x', 'Retention over', later);
    expect(await items(hold.id)).toEqual({});
    const { holds } = await ok<AdminHoldsResponse>(await asAdmin('/api/admin/holds'));
    expect(holds.find((h) => h.id === hold.id)).toMatchObject({
      releasedAt: later.toISOString(),
      releasedBy: 'admin-x',
      notes: 'Retention over',
    });
    expect(await auditKinds(hold.id)).toEqual(['hold_placed', 'hold_reported', 'hold_released']);

    // An unreported hold is released at once; releasing it again changes nothing.
    const other = await ok<AdminHold>(
      await asAdmin(`/api/admin/shares/${share.id}/hold`, {
        method: 'POST',
        json: { reason: 'other' },
      }),
    );
    const released = await ok<AdminHold>(
      await asAdmin(`/api/admin/holds/${other.id}/release`, { method: 'POST', json: {} }),
    );
    expect(released.releasedAt).not.toBeNull();
    await ok(await asAdmin(`/api/admin/holds/${other.id}/release`, { method: 'POST', json: {} }));
    expect(await auditKinds(other.id)).toEqual(['hold_placed', 'hold_released']);
    expect(
      (await asAdmin('/api/admin/holds/nope/release', { method: 'POST', json: {} })).status,
    ).toBe(404);
  });

  it('is hidden from everyone but admins, and no admin route returns the held copies', async () => {
    const { user, asAdmin, asUser, share } = await setup();
    const hold = await ok<AdminHold>(
      await asAdmin(`/api/admin/shares/${share.id}/hold`, {
        method: 'POST',
        json: { reason: 'csam' },
      }),
    );
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/admin/holds'],
      ['POST', `/api/admin/shares/${share.id}/hold`, { reason: 'other' }],
      ['POST', `/api/admin/holds/${hold.id}/release`, {}],
      ['POST', `/api/admin/holds/${hold.id}/external-report`, { kind: 'ncmec', reference: 'x' }],
    ];
    for (const [method, path, body] of routes) {
      const res = await asUser(path, { method, ...(body ? { json: body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    // Revoked, so the content is only in the hold now; then every admin GET is checked.
    await ok(await asUser(`/api/shares/${share.id}/revoke`, { method: 'POST' }));
    for (const path of [
      '/api/admin/holds',
      '/api/admin/users',
      `/api/admin/users/${user.id}/shares`,
      '/api/admin/status',
    ]) {
      const res = await asAdmin(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain(HELD);
    }
    const reported = await asAdmin(`/api/admin/holds/${hold.id}/external-report`, {
      method: 'POST',
      json: { kind: 'law_enforcement', reference: 'FBI-1' },
    });
    expect(await reported.text()).not.toContain(HELD);

    // Only share/legal-hold.ts touches the copies, and it never reads them back.
    const touching = Object.entries(SOURCES).filter(([, text]) =>
      text.includes('legal_hold_items'),
    );
    expect(touching.map(([path]) => path.replace(/^.*\/src\//, 'src/')).sort()).toEqual([
      'src/db/schema.ts',
      'src/share/legal-hold.ts',
    ]);
    const holdModule = touching.find(([path]) => path.endsWith('/share/legal-hold.ts'))![1];
    expect(holdModule).not.toMatch(/SELECT[^;`]*FROM\s+legal_hold_items/i);
  });
});
