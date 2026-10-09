import type {
  AdminCreditResponse,
  AdminStatusResponse,
  AdminUser,
  AdminUsersResponse,
  ApiError,
  MeResponse,
  ShareSummary,
  TreeDetail,
} from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AppEnv } from '../src/env.js';
import { makeNode } from './fixtures.js';
import { insertSubscription } from './mocks/billing-helpers.js';
import { authEnv, client } from './session-client.js';
import { ok } from './http.js';

const ADMIN_INDEX = '<!doctype html><title>admin</title>';

/** Workers Static Assets stand-in: every document is the admin app's index.html. */
const assets = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const js = new URL(req.url).pathname.endsWith('.js');
    return Promise.resolve(
      new Response(js ? 'console.log(1)' : ADMIN_INDEX, {
        headers: { 'Content-Type': js ? 'text/javascript' : 'text/html; charset=utf-8' },
      }),
    );
  },
} as unknown as Fetcher;

/** Sharing off (no DMCA agent registered), with `adminIds` as ADMIN_USER_IDS. */
function offEnv(adminIds = ''): AppEnv {
  return authEnv({ DMCA_AGENT_REGISTERED: 'false', ADMIN_USER_IDS: adminIds, ASSETS: assets });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as ApiError).error.code;
}

let emailSeq = 0;
async function newUser(e: AppEnv, prefix = 'user') {
  const c = client(e);
  const email = `${prefix}${++emailSeq}-${Math.random().toString(36).slice(2, 8)}@example.org`;
  await c.signIn(email);
  const me = await ok<MeResponse>(await c.call('/api/me'));
  return { ...c, me, email, id: me.userId! };
}
type User = Awaited<ReturnType<typeof newUser>>;

/**
 * Signs up an admin and a regular user. The admin's id is only known once it
 * exists, so the env listing it is built afterwards and passed on every call.
 */
async function setup() {
  const signup = offEnv();
  const admin = await newUser(signup, 'admin');
  const user = await newUser(signup);
  const e = offEnv(` other-id, ${admin.id} ,,`);
  const as =
    (u: User) =>
    (path: string, init: Parameters<User['call']>[1] = {}) =>
      u.call(path, init, e);
  return { e, admin, user, asAdmin: as(admin), asUser: as(user) };
}

/** A tree with one exchange on its trunk, owned by the caller's power account. */
async function seedTree(
  call: (path: string, init?: Parameters<User['call']>[1]) => Promise<Response>,
) {
  const detail = await ok<TreeDetail>(
    await call('/api/trees', { method: 'POST', json: { title: 'Mine' } }),
    201,
  );
  const trunk = detail.branches[0]!;
  const q = makeNode(trunk, 0, null, { role: 'user', content: 'PUBLISHED-QUESTION' });
  const a = makeNode(trunk, 1, q.id, { role: 'assistant', content: 'An answer' });
  await createD1Repositories(env.DB).trees.appendNodes([q, a], new Date().toISOString());
  return detail.tree.id;
}

async function shareAllowedInDb(userId: string): Promise<number | undefined> {
  const row = await env.DB.prepare('SELECT share_allowed AS allowed FROM auth_users WHERE id = ?')
    .bind(userId)
    .first<{ allowed: number }>();
  return row?.allowed;
}

describe('admin identity', () => {
  it('reports the user id and admin status in /api/me', async () => {
    const { admin, user, asAdmin, asUser } = await setup();
    expect(admin.id).toBe(admin.me.accountId.slice('p_'.length));
    const a = await ok<MeResponse>(await asAdmin('/api/me'));
    expect(a).toMatchObject({ userId: admin.id, isAdmin: true, sharing: true });
    const u = await ok<MeResponse>(await asUser('/api/me'));
    expect(u).toMatchObject({ userId: user.id, isAdmin: false, sharing: false });
  });

  it('hides the admin API and app from everyone else behind a 404', async () => {
    const { e, user, asUser } = await setup();
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/admin/status'],
      ['GET', '/api/admin/users'],
      ['GET', `/api/admin/users/${user.id}/shares`],
      ['PATCH', `/api/admin/users/${user.id}`, { shareAllowed: true }],
      ['POST', '/api/admin/shares/nope/revoke'],
    ];
    for (const [method, path, body] of routes) {
      const res = await asUser(path, { method, ...(body ? { json: body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await errorCode(res)).toBe('not_found');
    }
    expect(await shareAllowedInDb(user.id)).toBe(0);

    for (const path of ['/admin', '/admin/', '/admin/users', '/admin/index.html']) {
      const res = await asUser(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain(ADMIN_INDEX);
    }
    // Signed out: the same 404 for the app; the API wants a session like every /api route.
    const anon = client(e);
    expect((await anon.call('/admin/')).status).toBe(404);
    expect((await anon.call('/admin')).status).toBe(404);
    expect((await anon.call('/api/admin/status')).status).toBe(401);
  });

  it('serves the admin app to admins, uncached', async () => {
    const { asAdmin } = await setup();
    const bare = await asAdmin('/admin', { redirect: 'manual' });
    expect(bare.status).toBe(301);
    expect(bare.headers.get('Location')).toBe('/admin/');
    for (const path of ['/admin/', '/admin/users']) {
      const res = await asAdmin(path);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe(ADMIN_INDEX);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Content-Security-Policy')).toContain(
        "require-trusted-types-for 'script'",
      );
    }
    // No login page of its own: /admin/login is just another route, with the app CSP.
    const login = await asAdmin('/admin/login');
    expect(login.headers.get('Content-Security-Policy')).not.toContain('challenges.cloudflare.com');
  });

  it('serves the app files to anyone', async () => {
    const { e } = await setup();
    const res = await client(e).call('/admin/main-abc.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');
  });

  it('treats the local dev bypass as admin', async () => {
    const dev = client(offEnv());
    const e = { ...offEnv(), BETTER_AUTH_SECRET: '', DEV_ALLOW_NO_AUTH: 'true' } as AppEnv;
    const me = await ok<MeResponse>(await dev.call('/api/me', {}, e));
    // Admin, but sharing follows the global flag in the dev bypass.
    expect(me).toMatchObject({ userId: null, isAdmin: true, sharing: false });
    expect((await dev.call('/admin/', {}, e)).status).toBe(200);
    expect(await ok<AdminStatusResponse>(await dev.call('/api/admin/status', {}, e))).toEqual({
      dmcaAgentRegistered: false,
      membershipRequired: false,
    });
  });
});

describe('admin API', () => {
  it('reports whether a DMCA agent is registered and the membership required', async () => {
    const { admin, e } = await setup();
    expect(await ok<AdminStatusResponse>(await admin.call('/api/admin/status', {}, e))).toEqual({
      dmcaAgentRegistered: false,
      membershipRequired: false,
    });
    const on = {
      ...e,
      DMCA_AGENT_REGISTERED: 'true',
      ANNUAL_FEE_ENABLED: 'true',
    } as AppEnv;
    expect(await ok<AdminStatusResponse>(await admin.call('/api/admin/status', {}, on))).toEqual({
      dmcaAgentRegistered: true,
      membershipRequired: true,
    });
  });

  it('lists users newest first, searchable by email', async () => {
    const { admin, user, asAdmin } = await setup();
    const all = await ok<AdminUsersResponse>(await asAdmin('/api/admin/users'));
    const ids = all.users.map((u) => u.id);
    expect(ids.indexOf(user.id)).toBeLessThan(ids.indexOf(admin.id));
    expect(all.users.find((u) => u.id === admin.id)).toMatchObject({
      email: admin.email,
      isAdmin: true,
      shareAllowed: false,
      activeShares: 0,
      creditBalanceMicros: 0,
      membershipWaived: false,
      membershipPaid: false,
    });

    const found = await ok<AdminUsersResponse>(
      await asAdmin(`/api/admin/users?q=${encodeURIComponent(user.email.toUpperCase())}`),
    );
    expect(found.users.map((u) => u.id)).toEqual([user.id]);
    expect(found.nextCursor).toBeNull();
    // `%` and `_` are plain characters, not LIKE wildcards.
    const none = await ok<AdminUsersResponse>(await asAdmin('/api/admin/users?q=%25'));
    expect(none.users).toEqual([]);

    expect((await asAdmin('/api/admin/users?cursor=bogus')).status).toBe(400);
  });

  it("shows each user's credit balance, as an admin credit leaves it", async () => {
    const { user, asAdmin } = await setup();
    const credit = await asAdmin('/api/admin/credit', {
      method: 'POST',
      json: {
        target: 'personal',
        userId: user.id,
        amountCents: 1250,
        mode: 'adjustment',
        idempotencyKey: `test-${crypto.randomUUID()}`,
      },
    });
    expect(await ok<AdminCreditResponse>(credit)).toMatchObject({
      credited: true,
      balanceMicros: 12_500_000,
    });
    const found = await ok<AdminUsersResponse>(
      await asAdmin(`/api/admin/users?q=${encodeURIComponent(user.email)}`),
    );
    expect(found.users).toMatchObject([{ id: user.id, creditBalanceMicros: 12_500_000 }]);
  });

  it('waives a membership, keeping when it was first waived, and takes the waiver back', async () => {
    const { e, user, asAdmin } = await setup();
    const fee = { ...e, ANNUAL_FEE_ENABLED: 'true' } as AppEnv;
    const status = async () =>
      (await ok<MeResponse>(await user.call('/api/me', {}, fee))).membership.status;
    const waivedAt = async () =>
      (
        await env.DB.prepare('SELECT membership_waived_at AS at FROM auth_users WHERE id = ?')
          .bind(user.id)
          .first<{ at: string | null }>()
      )?.at;
    const patch = async (membershipWaived: boolean) =>
      ok<AdminUser>(
        await asAdmin(`/api/admin/users/${user.id}`, {
          method: 'PATCH',
          json: { membershipWaived },
        }),
      );

    expect(await status()).toBe('inactive');
    expect(await patch(true)).toMatchObject({
      id: user.id,
      membershipWaived: true,
      membershipPaid: false,
    });
    expect(await status()).toBe('waived');
    const first = await waivedAt();
    expect(first).toBeTruthy();
    await patch(true);
    expect(await waivedAt()).toBe(first);

    expect(await patch(false)).toMatchObject({ membershipWaived: false });
    expect(await status()).toBe('inactive');

    // A paid membership is listed, and clearing a waiver leaves it.
    await insertSubscription(env as unknown as AppEnv, user.id, 'active');
    expect(await patch(false)).toMatchObject({ membershipWaived: false, membershipPaid: true });
    expect(await status()).toBe('active');
  });

  it('pages with a cursor', async () => {
    const { asAdmin } = await setup();
    // More users than one page holds (pages are newest first, so these lead the list).
    await env.DB.batch(
      Array.from({ length: 55 }, (_, i) =>
        env.DB.prepare(
          'INSERT INTO auth_users (id, name, email, email_verified, created_at, updated_at) VALUES (?1, ?2, ?3, 1, ?4, ?4)',
        ).bind(`bulk-${i}`, 'Bulk', `bulk-${i}@paging.test`, Date.now() + 60_000 + i),
      ),
    );
    const first = await ok<AdminUsersResponse>(await asAdmin('/api/admin/users?q=paging.test'));
    expect(first.users).toHaveLength(50);
    expect(first.users[0]!.id).toBe('bulk-54');
    const next = await ok<AdminUsersResponse>(
      await asAdmin(`/api/admin/users?q=paging.test&cursor=${first.nextCursor!}`),
    );
    expect(next.users.map((u) => u.id)).toEqual(['bulk-4', 'bulk-3', 'bulk-2', 'bulk-1', 'bulk-0']);
    expect(next.nextCursor).toBeNull();
  });

  it('PATCH validates, 404s unknown users and is same-origin only', async () => {
    const { user, asAdmin } = await setup();
    const path = `/api/admin/users/${user.id}`;
    expect((await asAdmin(path, { method: 'PATCH', json: { shareAllowed: 'yes' } })).status).toBe(
      400,
    );
    expect(
      (await asAdmin('/api/admin/users/nobody', { method: 'PATCH', json: { shareAllowed: true } }))
        .status,
    ).toBe(404);
    const cross = await asAdmin(path, {
      method: 'PATCH',
      json: { shareAllowed: true },
      headers: { 'Sec-Fetch-Site': 'same-site' },
    });
    expect(cross.status).toBe(403);
    expect(await shareAllowedInDb(user.id)).toBe(0);
  });

  it("users can't grant themselves the permission through Better Auth", async () => {
    const { user, asUser } = await setup();
    const res = await asUser('/api/auth/update-user', {
      method: 'POST',
      headers: { origin: 'https://tangent.example.com' },
      json: { name: 'Renamed', shareAllowed: true, share_allowed: 1 },
    });
    expect(res.status, await res.text()).toBe(200);
    expect(await shareAllowedInDb(user.id)).toBe(0);
    expect((await ok<MeResponse>(await asUser('/api/me'))).sharing).toBe(false);
  });
});

describe('the share allowlist while sharing is off', () => {
  it('lets allowed users publish, and takes their links down the moment it is revoked', async () => {
    const { user, asAdmin, asUser } = await setup();
    const treeId = await seedTree(asUser);
    const create = () => asUser('/api/shares', { method: 'POST', json: { treeId, scope: 'tree' } });

    // Not allowed yet.
    expect((await create()).status).toBe(403);

    const allowed = await ok<AdminUser>(
      await asAdmin(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        json: { shareAllowed: true },
      }),
    );
    expect(allowed).toMatchObject({ id: user.id, shareAllowed: true, activeShares: 0 });
    expect((await ok<MeResponse>(await asUser('/api/me'))).sharing).toBe(true);

    const share = await ok<ShareSummary>(await create(), 201);
    const anon = client(offEnv());
    const page = await anon.call(`/s/${share.token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('PUBLISHED-QUESTION');
    // Twice, so the second can come from the edge cache.
    expect((await anon.call(`/s/${share.token}/data.json`)).status).toBe(200);
    const cached = await anon.call(`/s/${share.token}/data.json`);
    expect(cached.status).toBe(200);
    expect(cached.headers.get('X-Share-Cache')).toBe('HIT');
    expect(
      (await asUser(`/api/shares/${share.id}`, { method: 'PATCH', json: { title: 'T' } })).status,
    ).toBe(200);

    // Revoked: the links are gone at once, cached copies included, and nothing new is published.
    await ok<AdminUser>(
      await asAdmin(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        json: { shareAllowed: false },
      }),
    );
    const gone = await anon.call(`/s/${share.token}`);
    expect(gone.status).toBe(404);
    expect(await gone.text()).not.toContain('PUBLISHED-QUESTION');
    expect((await anon.call(`/s/${share.token}/data.json`)).status).toBe(404);
    expect((await create()).status).toBe(403);
    expect((await ok<MeResponse>(await asUser('/api/me'))).sharing).toBe(false);

    // With a DMCA agent registered the allowlist no longer matters.
    const on = offEnv();
    on.DMCA_AGENT_REGISTERED = 'true';
    expect((await anon.call(`/s/${share.token}`, {}, on)).status).toBe(200);
  });

  it("serves an admin's links without any permission row", async () => {
    const { e, asAdmin } = await setup();
    const treeId = await seedTree(asAdmin);
    const share = await ok<ShareSummary>(
      await asAdmin('/api/shares', { method: 'POST', json: { treeId, scope: 'tree' } }),
      201,
    );
    expect((await client(e).call(`/s/${share.token}`)).status).toBe(200);
    // Taken off ADMIN_USER_IDS, the admin's links are as closed as anyone's.
    expect((await client(offEnv()).call(`/s/${share.token}`)).status).toBe(404);
  });

  it("lists a user's shares and lets the admin take one down", async () => {
    const { e, user, asAdmin, asUser } = await setup();
    await asAdmin(`/api/admin/users/${user.id}`, { method: 'PATCH', json: { shareAllowed: true } });
    const treeId = await seedTree(asUser);
    const share = await ok<ShareSummary>(
      await asUser('/api/shares', { method: 'POST', json: { treeId, scope: 'tree' } }),
      201,
    );
    const found = await ok<AdminUsersResponse>(
      await asAdmin(`/api/admin/users?q=${encodeURIComponent(user.email)}`),
    );
    expect(found.users[0]).toMatchObject({ shareAllowed: true, activeShares: 1 });
    const listed = await ok<ShareSummary[]>(await asAdmin(`/api/admin/users/${user.id}/shares`));
    expect(listed.map((s) => s.id)).toEqual([share.id]);
    expect((await asAdmin('/api/admin/users/nobody/shares')).status).toBe(404);

    expect(
      (
        await asAdmin(`/api/admin/shares/${share.id}/revoke`, {
          method: 'POST',
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
    const revoked = await ok<ShareSummary>(
      await asAdmin(`/api/admin/shares/${share.id}/revoke`, { method: 'POST' }),
    );
    expect(revoked.state).toBe('revoked');
    expect((await client(e).call(`/s/${share.token}`)).status).toBe(410);
    expect((await asAdmin('/api/admin/shares/nope/revoke', { method: 'POST' })).status).toBe(404);
    const after = await ok<AdminUsersResponse>(
      await asAdmin(`/api/admin/users?q=${encodeURIComponent(user.email)}`),
    );
    expect(after.users[0]!.activeShares).toBe(0);
  });
});
