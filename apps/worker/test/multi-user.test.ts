import type {
  ApiError,
  Branch,
  LoginOptionsResponse,
  MeResponse,
  ProviderInfo,
  StreamEvent,
  TreeDetail,
  TreeSummary,
} from '@tangent/shared';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { REMEMBER_COOKIE } from '../src/auth/auth.js';
import { grantCredit } from '../src/billing/ledger.js';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { EmailMessage, EmailSender } from '../src/email/index.js';
import type { AppEnv } from '../src/env.js';
import { DEFAULT_SIMPLE_SYSTEM_PROMPT } from '../src/simple-mode.js';
import { makeNode } from './fixtures.js';

const ORIGIN = 'https://tangent.example.com';

class CapturingSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** Auth configured as in production, with open sign-up unless overridden. */
function authEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ...env,
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
    ALLOWED_EMAILS: 'owner@example.com',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_SITE_KEY: 'site-key',
    OPEN_SIGNUP: 'true',
    ...overrides,
  } as AppEnv;
}

let ipSeq = 0;

/** A client: its own IP (Better Auth rate limits are per IP) and, once signed in, its session cookie. */
function client(e: AppEnv = authEnv()) {
  const mail = new CapturingSender();
  const app = createApp({ auth: { emailSender: mail } });
  const ip = `198.51.100.${++ipSeq}`;
  let cookie = '';
  const call = async (
    path: string,
    init: RequestInit & { json?: unknown } = {},
    as: AppEnv = e,
  ) => {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set('cf-connecting-ip', ip);
    if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
    if (json !== undefined) headers.set('content-type', 'application/json');
    const ctx = createExecutionContext();
    const res = await app.request(
      `${ORIGIN}${path}`,
      { ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) },
      as,
      ctx,
    );
    // Read the body before waiting: a streamed response only finishes once consumed.
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    const nullBody = [101, 204, 205, 304].includes(res.status);
    return new Response(nullBody ? null : text, { status: res.status, headers: res.headers });
  };
  const signIn = async (email: string) => {
    const res = await call('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { origin: ORIGIN, 'x-captcha-response': 'pass' },
      json: { email, callbackURL: '/', errorCallbackURL: '/login' },
    });
    expect(res.status).toBe(200);
    const message = mail.sent.at(-1);
    if (!message) return null;
    const link = new URL(/https?:\/\/\S+/.exec(message.text)![0]);
    const verify = await call(link.pathname + link.search, {
      headers: { cookie: `${REMEMBER_COOKIE}=1` },
      redirect: 'manual',
    });
    cookie = verify.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .filter((pair) => !pair.endsWith('='))
      .join('; ');
    return cookie;
  };
  return { call, signIn, mail, env: e };
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as ApiError).error.code;
}

function parseSse(text: string): StreamEvent[] {
  return text
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as StreamEvent);
}

let emailSeq = 0;
/** Signs in a fresh non-allowlisted user; returns the client and its /api/me. */
async function simpleUser() {
  const c = client();
  await c.signIn(`learner${++emailSeq}-${Math.random().toString(36).slice(2, 8)}@example.org`);
  const me = await json<MeResponse>(await c.call('/api/me'));
  return { ...c, me };
}

/** A tree of `owner` with a user/assistant exchange on its trunk (written straight to D1). */
async function treeWithNodes(owner: Awaited<ReturnType<typeof simpleUser>>) {
  const detail = await json<TreeDetail>(
    await owner.call('/api/trees', { method: 'POST', json: { title: 'Mine' } }),
    201,
  );
  const trunk = detail.branches[0]!;
  const user = makeNode(trunk, 0, null, { role: 'user', content: 'What is a prime?' });
  const assistant = makeNode(trunk, 1, user.id, {
    role: 'assistant',
    content: 'What do you think?',
  });
  await createD1Repositories(env.DB).trees.appendNodes([user, assistant], new Date().toISOString());
  return { detail, trunk, user, assistant };
}

describe('accounts per user', () => {
  it('login options report open sign-up', async () => {
    expect(
      await json<LoginOptionsResponse>(await client().call('/api/login-options')),
    ).toMatchObject({
      configured: true,
      openSignup: true,
    });
    const closed = client(authEnv({ OPEN_SIGNUP: 'false' }));
    expect(await json<LoginOptionsResponse>(await closed.call('/api/login-options'))).toMatchObject(
      {
        openSignup: false,
      },
    );
  });

  it('two open sign-ups get distinct personal simple accounts', async () => {
    const a = await simpleUser();
    const b = await simpleUser();
    for (const u of [a, b]) {
      expect(u.me.mode).toBe('simple');
      expect(u.me.accountId).toMatch(/^u_.+/);
      expect(u.me.devMode).toBe(false);
    }
    expect(a.me.accountId).not.toBe(b.me.accountId);

    const row = await env.DB.prepare(
      'SELECT a.mode, a.user_id, u.email FROM accounts a JOIN auth_users u ON u.id = a.user_id WHERE a.id = ?1',
    )
      .bind(a.me.accountId)
      .first<{ mode: string; user_id: string; email: string }>();
    expect(row).toEqual({ mode: 'simple', user_id: a.me.accountId.slice(2), email: a.me.email });
  });

  it('an allowlisted email lands on the shared default power account', async () => {
    const owner = client();
    await owner.signIn('owner@example.com');
    expect(await json<MeResponse>(await owner.call('/api/me'))).toEqual({
      email: 'owner@example.com',
      devMode: false,
      accountId: 'default',
      mode: 'power',
    });
  });

  it('with OPEN_SIGNUP=false a non-allowlisted user is refused, even with a session', async () => {
    const closed = client(authEnv({ OPEN_SIGNUP: 'false' }));
    expect(await closed.signIn('outsider@example.org')).toBeNull();
    expect(closed.mail.sent).toHaveLength(0);

    // Signed up while sign-up was open; closing it locks the session out.
    const open = client();
    await open.signIn('early@example.org');
    expect((await open.call('/api/me')).status).toBe(200);
    const res = await open.call('/api/me', {}, authEnv({ OPEN_SIGNUP: 'false' }));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('forbidden');
  });
});

describe('simple accounts', () => {
  it('see only the tangent provider and cannot use their own keys', async () => {
    const u = await simpleUser();
    const providers = await json<ProviderInfo[]>(await u.call('/api/providers'));
    expect(providers.map((p) => p.id)).toEqual(['tangent']);
    expect(providers[0]!.models.map((m) => m.id)).toEqual(['smart', 'simple']);

    for (const res of [
      await u.call('/api/key/status'),
      await u.call('/api/key', {
        method: 'POST',
        json: { provider: 'ant', apiKey: 'sk-ant-good-x' },
      }),
      await u.call('/api/key', { method: 'DELETE', json: {} }),
    ]) {
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('forbidden');
    }
  });

  it('new trees use tangent and the built-in tutor prompt unless one is given', async () => {
    const u = await simpleUser();
    const plain = await json<TreeDetail>(
      await u.call('/api/trees', { method: 'POST', json: { title: 'A' } }),
      201,
    );
    expect(plain.tree.systemPrompt).toBe(DEFAULT_SIMPLE_SYSTEM_PROMPT);
    expect(plain.branches[0]).toMatchObject({ providerId: 'tangent', model: 'smart' });
    const own = await json<TreeDetail>(
      await u.call('/api/trees', {
        method: 'POST',
        json: { title: 'B', systemPrompt: 'Be brief.' },
      }),
      201,
    );
    expect(own.tree.systemPrompt).toBe('Be brief.');
  });
});

describe('ownership across accounts', () => {
  it("every branch and node route answers 404 for another account's tree", async () => {
    const a = await simpleUser();
    const b = await simpleUser();
    const { detail, trunk, user, assistant } = await treeWithNodes(a);
    const treeId = detail.tree.id;

    const attempts: [string, RequestInit & { json?: unknown }][] = [
      [`/api/trees/${treeId}`, {}],
      [`/api/branches/${trunk.id}`, { method: 'PATCH', json: { title: 'Mine now' } }],
      [`/api/branches/${trunk.id}`, { method: 'DELETE' }],
      [`/api/branches/${trunk.id}/context`, {}],
      [`/api/branches/${trunk.id}/context?resolve=true`, {}],
      [`/api/branches/${trunk.id}/messages`, { method: 'POST', json: { content: 'hi' } }],
      [`/api/nodes/${assistant.id}/stream`, {}],
      [`/api/nodes/${assistant.id}/cancel`, { method: 'POST' }],
      [
        `/api/nodes/${assistant.id}/review`,
        { method: 'POST', json: { providerId: 'tangent', model: 'smart' } },
      ],
      ['/api/branches', { method: 'POST', json: { fromNodeId: user.id } }],
    ];
    for (const [path, init] of attempts) {
      const res = await b.call(path, init);
      expect(res.status, `${init.method ?? 'GET'} ${path}`).toBe(404);
      expect(await errorCode(res)).toBe('not_found');
    }

    // B's list doesn't show it; the default account can't reach it either.
    const list = await json<TreeSummary[]>(await b.call('/api/trees'));
    expect(list.some((t) => t.id === treeId)).toBe(false);
    const owner = client();
    await owner.signIn('owner@example.com');
    expect(
      (await owner.call(`/api/branches/${trunk.id}`, { method: 'PATCH', json: { title: 'x' } }))
        .status,
    ).toBe(404);

    // Nothing changed, and A still has full access.
    const after = await json<TreeDetail>(await a.call(`/api/trees/${treeId}`));
    expect(after.branches).toHaveLength(1);
    expect(after.branches[0]!.title).toBe(trunk.title);
    expect(after.nodes).toHaveLength(2);
    const renamed = await json<Branch>(
      await a.call(`/api/branches/${trunk.id}`, { method: 'PATCH', json: { title: 'Primes' } }),
    );
    expect(renamed.title).toBe('Primes');
    const child = await json<Branch>(
      await a.call('/api/branches', { method: 'POST', json: { fromNodeId: assistant.id } }),
      201,
    );
    expect(child.treeId).toBe(treeId);
    expect((await a.call(`/api/branches/${trunk.id}/context`)).status).toBe(200);
  });
});

describe('simple-mode spending', () => {
  it('402 without credit; after a grant the send streams and is charged cost + 10%', async () => {
    const u = await simpleUser();
    const { trunk, assistant } = await treeWithNodes(u);

    for (const [path, init] of [
      [
        `/api/branches/${trunk.id}/messages`,
        { method: 'POST', json: { content: 'Explain primes' } },
      ],
      [
        `/api/nodes/${assistant.id}/review`,
        { method: 'POST', json: { providerId: 'tangent', model: 'smart' } },
      ],
      [`/api/branches/${trunk.id}/context?resolve=true`, {}],
    ] as [string, RequestInit & { json?: unknown }][]) {
      const res = await u.call(path, init);
      expect(res.status, path).toBe(402);
      expect(await errorCode(res)).toBe('payment_required');
    }
    // A plain context plan costs nothing and stays available.
    expect((await u.call(`/api/branches/${trunk.id}/context`)).status).toBe(200);

    await grantCredit(env.DB, {
      accountId: u.me.accountId,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      stripeRef: null,
      note: 'test',
    });
    const res = await u.call(`/api/branches/${trunk.id}/messages`, {
      method: 'POST',
      json: { content: 'Explain primes' },
    });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events[0]?.type).toBe('start');
    expect(events.at(-1)?.type).toBe('done');

    const rows = await env.DB.prepare(
      'SELECT status, cost_nanos, charge_micros, provider_id FROM usage_events WHERE account_id = ?1',
    )
      .bind(u.me.accountId)
      .all<{ status: string; cost_nanos: number; charge_micros: number; provider_id: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    // The fake provider reports $0.001234 per call: 1,234,000 nano-USD; +10% rounded up to micro-USD.
    const charge = Math.ceil((1_234_000 * 11_000) / 10_000_000);
    for (const row of rows.results) {
      expect(row).toEqual({
        status: 'settled',
        cost_nanos: 1_234_000,
        charge_micros: charge,
        provider_id: 'tangent',
      });
    }
  });
});
