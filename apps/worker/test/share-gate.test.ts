// Who may publish a share link beyond SHARING and the allowlist (admin.test.ts):
// a sharing suspension, the account's age and the daily limit, and the audit
// log every change to a link leaves.
import type { ApiError, MeResponse, ShareSummary, TreeDetail } from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AppEnv } from '../src/env.js';
import { makeNode } from './fixtures.js';
import { ok } from './http.js';
import { authEnv, client } from './session-client.js';

// @ts-expect-error -- `import.meta.glob` is Vite's; the worker tsconfig has no vite/client types.
const SOURCES = import.meta.glob('../src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const DAY_MS = 86_400_000;

/** Sharing for everyone, a day's minimum age and two new links a day; `adminIds` as ADMIN_USER_IDS. */
function gateEnv(adminIds = ''): AppEnv {
  return authEnv({
    SHARING: 'everyone',
    SHARE_MIN_ACCOUNT_AGE_MS: String(DAY_MS),
    SHARE_CREATES_PER_DAY: '2',
    ADMIN_USER_IDS: adminIds,
  });
}

let emailSeq = 0;
async function newUser(e: AppEnv) {
  const c = client(e);
  const email = `gate${++emailSeq}-${Math.random().toString(36).slice(2, 8)}@example.org`;
  await c.signIn(email);
  const me = await ok<MeResponse>(await c.call('/api/me'));
  return { ...c, id: me.userId! };
}
type User = Awaited<ReturnType<typeof newUser>>;

async function age(userId: string, ms: number): Promise<void> {
  await env.DB.prepare('UPDATE auth_users SET created_at = ? WHERE id = ?')
    .bind(Date.now() - ms, userId)
    .run();
}

async function seedTree(u: User): Promise<string> {
  const detail = await ok<TreeDetail>(
    await u.call('/api/trees', { method: 'POST', json: { title: 'Mine' } }),
    201,
  );
  const trunk = detail.branches[0]!;
  const q = makeNode(trunk, 0, null, { role: 'user', content: 'GATED-QUESTION' });
  const a = makeNode(trunk, 1, q.id, { role: 'assistant', content: 'An answer' });
  await createD1Repositories(env.DB).trees.appendNodes([q, a], new Date().toISOString());
  return detail.tree.id;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as ApiError).error.code;
}

interface AuditRow {
  kind: string;
  actor: string;
  actor_user_id: string | null;
  subject_user_id: string | null;
  share_id: string | null;
  data: string | null;
}

async function auditOf(shareId: string): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT kind, actor, actor_user_id, subject_user_id, share_id, data
     FROM audit_events WHERE share_id = ? ORDER BY at, rowid`,
  )
    .bind(shareId)
    .all<AuditRow>();
  return results;
}

describe('publishing gates', () => {
  it('lets an account publish once it is a day old; admins at once', async () => {
    const signup = gateEnv();
    const user = await newUser(signup);
    const admin = await newUser(signup);
    const e = gateEnv(admin.id);
    const treeId = await seedTree(user);
    const create = (u: User) =>
      u.call('/api/shares', { method: 'POST', json: { treeId, scope: 'tree' } }, e);

    const fresh = await create(user);
    expect(fresh.status).toBe(403);
    expect(await errorCode(fresh)).toBe('forbidden');

    await age(user.id, DAY_MS + 60_000);
    await ok<ShareSummary>(await create(user), 201);

    const adminTree = await seedTree(admin);
    await ok<ShareSummary>(
      await admin.call(
        '/api/shares',
        { method: 'POST', json: { treeId: adminTree, scope: 'tree' } },
        e,
      ),
      201,
    );
  });

  it('caps new links a day, deleted ones included; edits and republishes are not new links', async () => {
    const e = gateEnv();
    const user = await newUser(e);
    await age(user.id, 2 * DAY_MS);
    const treeId = await seedTree(user);
    const create = () =>
      user.call('/api/shares', { method: 'POST', json: { treeId, scope: 'tree' } }, e);

    const first = await ok<ShareSummary>(await create(), 201);
    await ok<ShareSummary>(await create(), 201);
    const third = await create();
    expect(third.status).toBe(429);
    expect(await errorCode(third)).toBe('rate_limited');

    expect((await user.call(`/api/shares/${first.id}`, { method: 'DELETE' }, e)).status).toBe(204);
    expect((await create()).status).toBe(429);

    const [other] = await ok<ShareSummary[]>(await user.call('/api/shares', {}, e));
    await ok(await user.call(`/api/shares/${other!.id}/republish`, { method: 'POST' }, e));
    await ok(
      await user.call(`/api/shares/${other!.id}`, { method: 'PATCH', json: { title: 'T' } }, e),
    );
  });

  it('counts refused publishes against the daily limit, so the classifier is not open to retries', async () => {
    const e = gateEnv();
    const user = await newUser(e);
    await age(user.id, 2 * DAY_MS);
    const flagged = await seedTree(user);
    const trunk = (await ok<TreeDetail>(await user.call(`/api/trees/${flagged}`, {}, e)))
      .branches[0]!;
    const repos = createD1Repositories(env.DB);
    const last = (await repos.trees.listNodes(flagged)).at(-1)!;
    await repos.trees.appendNodes(
      [makeNode(trunk, 2, last.id, { role: 'user', content: 'Again [mod-violent]' })],
      new Date().toISOString(),
    );
    const create = (treeId: string) =>
      user.call('/api/shares', { method: 'POST', json: { treeId, scope: 'tree' } }, e);

    expect((await create(flagged)).status).toBe(403);
    const fine = await seedTree(user);
    const share = await ok<ShareSummary>(await create(fine), 201);
    const third = await create(fine);
    expect(third.status).toBe(429);
    expect(await errorCode(third)).toBe('rate_limited');

    // Refused edits count too, and once they reach the limit they stop being screened.
    const retitle = () =>
      user.call(
        `/api/shares/${share.id}`,
        { method: 'PATCH', json: { title: 'Title [mod-violent]' } },
        e,
      );
    expect((await retitle()).status).toBe(403);
    const capped = await retitle();
    expect(capped.status).toBe(429);
    expect(await errorCode(capped)).toBe('rate_limited');
  });

  it('a sharing suspension refuses new links and takes the old ones down, admins included', async () => {
    const signup = gateEnv();
    const admin = await newUser(signup);
    const e = gateEnv(admin.id);
    const treeId = await seedTree(admin);
    const share = await ok<ShareSummary>(
      await admin.call('/api/shares', { method: 'POST', json: { treeId, scope: 'tree' } }, e),
      201,
    );
    const anon = client(e);
    expect((await anon.call(`/s/${share.token}`)).status).toBe(200);

    await env.DB.prepare('UPDATE auth_users SET sharing_suspended = 1 WHERE id = ?')
      .bind(admin.id)
      .run();
    const page = await anon.call(`/s/${share.token}`);
    expect(page.status).toBe(404);
    expect(await page.text()).not.toContain('GATED-QUESTION');
    expect((await anon.call(`/s/${share.token}/data.json`)).status).toBe(404);
    expect((await ok<MeResponse>(await admin.call('/api/me', {}, e))).sharing).toBe(false);
    const create = await admin.call(
      '/api/shares',
      { method: 'POST', json: { treeId, scope: 'tree' } },
      e,
    );
    expect(create.status).toBe(403);
    expect(
      (await admin.call(`/api/shares/${share.id}/republish`, { method: 'POST' }, e)).status,
    ).toBe(403);
    // Owners still take their links down.
    expect((await admin.call(`/api/shares/${share.id}/revoke`, { method: 'POST' }, e)).status).toBe(
      200,
    );
  });
});

describe('the audit log', () => {
  it("records every change to a link, the owner's and an admin's, without its content", async () => {
    const signup = gateEnv();
    const admin = await newUser(signup);
    const user = await newUser(signup);
    await age(user.id, 2 * DAY_MS);
    const e = gateEnv(admin.id);
    const treeId = await seedTree(user);
    const share = await ok<ShareSummary>(
      await user.call(
        '/api/shares',
        { method: 'POST', json: { treeId, scope: 'tree', title: 'SECRET-TITLE' } },
        e,
      ),
      201,
    );
    await ok(
      await user.call(`/api/shares/${share.id}`, { method: 'PATCH', json: { title: 'T2' } }, e),
    );
    await ok(await user.call(`/api/shares/${share.id}/republish`, { method: 'POST' }, e));
    await ok(await admin.call(`/api/admin/shares/${share.id}/revoke`, { method: 'POST' }, e));
    expect((await user.call(`/api/shares/${share.id}`, { method: 'DELETE' }, e)).status).toBe(204);

    const rows = await auditOf(share.id);
    expect(rows.map((r) => [r.kind, r.actor, r.actor_user_id, r.subject_user_id])).toEqual([
      ['share_screened', 'system', null, user.id],
      ['share_created', 'user', user.id, user.id],
      ['share_screened', 'system', null, user.id],
      ['share_updated', 'user', user.id, user.id],
      ['share_screened', 'system', null, user.id],
      ['share_republished', 'user', user.id, user.id],
      ['share_revoked', 'admin', admin.id, user.id],
      ['share_deleted', 'user', user.id, user.id],
    ]);
    expect(JSON.parse(rows[5]!.data!)).toEqual({ version: 2, scope: 'tree' });
    expect(rows.filter((r) => r.kind === 'share_screened').map((r) => JSON.parse(r.data!))).toEqual(
      ['create', 'title', 'republish'].map((trigger) => ({
        trigger,
        verdict: 'allow',
        maxScores: expect.objectContaining({ 'sexual/minors': 0.001, violence: 0.001 }),
      })),
    );
    const all = JSON.stringify(rows);
    expect(all).not.toContain('GATED-QUESTION');
    expect(all).not.toContain('SECRET-TITLE');
  });

  it('is append-only: no source updates or deletes a row', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, text]) =>
        /\b(UPDATE\s+audit_events|DELETE\s+FROM\s+audit_events|REPLACE\s+INTO\s+audit_events|DROP\s+TABLE\s+audit_events)\b/i.test(
          text,
        ),
      )
      .map(([path]) => path);
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
