import {
  type AdminWaitlistInviteResponse,
  type AdminWaitlistResponse,
  type LoginOptionsResponse,
  type MeResponse,
} from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env.js';
import { BASE, ok } from './http.js';
import { authEnv, client } from './session-client.js';

let seq = 0;
const address = (tag: string) =>
  `${tag}-${++seq}-${Math.random().toString(36).slice(2, 8)}@example.org`;

const userCount = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_users').first<{ n: number }>())!.n;

const waiting = (email: string) =>
  env.DB.prepare('SELECT email, invited_at FROM waitlist WHERE email = ?')
    .bind(email.toLowerCase())
    .first<{ email: string; invited_at: string | null }>();

function join(c: ReturnType<typeof client>, email: string, captchaToken = 'pass') {
  return c.call('/api/waitlist', {
    method: 'POST',
    headers: { origin: BASE },
    json: { email, captchaToken },
  });
}

/** An admin, signed up while there is room, and the env listing them in ADMIN_USER_IDS. */
async function admin(overrides: Partial<AppEnv> = {}) {
  const c = client(authEnv({ MAX_USERS: '' }));
  await c.signIn(address('admin'));
  const me = await ok<MeResponse>(await c.call('/api/me'));
  const e = authEnv({ ADMIN_USER_IDS: me.userId!, ...overrides });
  return {
    ...c,
    e,
    as: (path: string, init: Parameters<typeof c.call>[1] = {}) => c.call(path, init, e),
  };
}

describe('login options', () => {
  it('say whether sign-ups are open', async () => {
    await client().signIn(address('someone'));
    const open = await ok<LoginOptionsResponse>(await client().call('/api/login-options'));
    expect(open.signupsOpen).toBe(true);
    const full = client(authEnv({ MAX_USERS: String(await userCount()) }));
    expect(
      (await ok<LoginOptionsResponse>(await full.call('/api/login-options'))).signupsOpen,
    ).toBe(false);
  });
});

describe('POST /api/waitlist', () => {
  it('records the address, lowercased, with a Turnstile pass', async () => {
    const email = address('Waiter');
    expect((await join(client(), email)).status).toBe(204);
    expect(await waiting(email)).toEqual({ email: email.toLowerCase(), invited_at: null });
    // Joining again changes nothing.
    expect((await join(client(), email.toUpperCase())).status).toBe(204);
  });

  it('refuses without a Turnstile pass', async () => {
    const email = address('bot');
    expect((await join(client(), email, 'not-a-pass')).status).toBe(400);
    expect(await waiting(email)).toBeNull();
  });

  it("doesn't add a user, and answers the same so it reveals nothing", async () => {
    const c = client();
    const email = address('member');
    await c.signIn(email);
    expect((await join(client(), email)).status).toBe(204);
    expect(await waiting(email)).toBeNull();
  });

  it('is public, but same-origin only', async () => {
    const res = await client().call('/api/waitlist', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
      json: { email: address('cross'), captchaToken: 'pass' },
    });
    expect(res.status).toBe(403);
  });

  it('takes an address off once it signs up', async () => {
    const email = address('patient');
    await join(client(), email);
    await client(authEnv({ MAX_USERS: '' })).signIn(email);
    expect(await waiting(email)).toBeNull();
  });
});

describe('admin waitlist', () => {
  it('is for admins only', async () => {
    const c = client();
    await c.signIn(address('nobody'));
    expect((await c.call('/api/admin/waitlist')).status).toBe(404);
  });

  it('lists the waitlist oldest first, with the cap and how many users there are', async () => {
    const a = await admin({ MAX_USERS: '500' });
    const first = address('first');
    const second = address('second');
    await join(client(), first);
    await join(client(), second);
    const list = await ok<AdminWaitlistResponse>(await a.as('/api/admin/waitlist'));
    const mine = list.entries.map((e) => e.email).filter((e) => e === first || e === second);
    expect(mine).toEqual([first, second]);
    expect(list.maxUsers).toBe(500);
    expect(list.users).toBe(await userCount());
    expect(list.total).toBeGreaterThanOrEqual(2);
  });

  it('invites: emails a sign-up link and records when, skipping addresses not waiting', async () => {
    const a = await admin();
    const email = address('invitee');
    await join(client(), email);
    const res = await ok<AdminWaitlistInviteResponse>(
      await a.as('/api/admin/waitlist/invite', {
        method: 'POST',
        headers: { origin: BASE },
        json: { emails: [email, address('stranger')] },
      }),
    );
    expect(res).toEqual({ invited: 1 });
    const sent = a.mail.sent.at(-1)!;
    expect(sent.to).toBe(email);
    expect(sent.subject).toBe("There's room on Tangent now");
    expect(sent.text).toContain(`${BASE}/login`);
    expect((await waiting(email))?.invited_at).not.toBeNull();
  });

  it('removes an address (a deletion request)', async () => {
    const a = await admin();
    const email = address('leaver');
    await join(client(), email);
    const path = `/api/admin/waitlist/${encodeURIComponent(email)}`;
    const init = { method: 'DELETE', headers: { origin: BASE } };
    expect((await a.as(path, init)).status).toBe(204);
    expect(await waiting(email)).toBeNull();
    expect((await a.as(path, init)).status).toBe(404);
  });
});
