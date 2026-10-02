import {
  DEFAULT_SYSTEM_PROMPT,
  MODE_HEADER,
  PAYMENT_HEADER,
  type ApiError,
  type Branch,
  type LearnPayment,
  type LoginOptionsResponse,
  type MeResponse,
  type ProviderInfo,
  type SettingsResponse,
  type ShareSummary,
  type StreamEvent,
  type TreeDetail,
  type TreeSummary,
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
import { makeNode } from './fixtures.js';

const ORIGIN = 'https://tangent.example.com';
/** The Anthropic-style mock upstream of vitest.config.ts: `sk-ant-good…` keys work, replies echo `key=<rest>`. */
const MOCK_UPSTREAM = 'https://llm.test';

class CapturingSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** Auth configured as in production: open sign-up, Stripe and the fake `tangent` provider from vitest.config.ts. */
function authEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ...env,
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_SITE_KEY: 'site-key',
    ...overrides,
  } as AppEnv;
}

type CallInit = RequestInit & { json?: unknown; learn?: LearnPayment };

let ipSeq = 0;

/**
 * A browser: its own IP (Better Auth rate limits are per IP) and cookie jar.
 * `learn` sends the request as Tangent Learn does (mode and payment headers);
 * without it the request is the power app's.
 */
function client(e: AppEnv = authEnv()) {
  const mail = new CapturingSender();
  const app = createApp({ auth: { emailSender: mail } });
  const ip = `198.51.100.${++ipSeq}`;
  const jar = new Map<string, string>();
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0]!;
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      if (eq === pair.length - 1 || /Max-Age=0/i.test(c)) jar.delete(name);
      else jar.set(name, pair.slice(eq + 1));
    }
  };
  const call = async (path: string, init: CallInit = {}, as: AppEnv = e) => {
    const { json, learn, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set('cf-connecting-ip', ip);
    if (jar.size > 0 && !headers.has('cookie')) {
      headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    if (json !== undefined) headers.set('content-type', 'application/json');
    if (learn) {
      headers.set(MODE_HEADER, 'simple');
      headers.set(PAYMENT_HEADER, learn);
    }
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
    keep(res);
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
    const message = mail.sent.at(-1)!;
    const link = new URL(/https?:\/\/\S+/.exec(message.text)![0]);
    await call(link.pathname + link.search, {
      headers: { cookie: `${REMEMBER_COOKIE}=1` },
      redirect: 'manual',
    });
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

function replyText(events: StreamEvent[]): string {
  return events.map((ev) => (ev.type === 'delta' ? ev.text : '')).join('');
}

let emailSeq = 0;
/** Signs up a fresh user; returns the client and its /api/me in both modes. */
async function newUser(e: AppEnv = authEnv(), email?: string) {
  const c = client(e);
  await c.signIn(
    email ?? `user${++emailSeq}-${Math.random().toString(36).slice(2, 8)}@example.org`,
  );
  const power = await json<MeResponse>(await c.call('/api/me'));
  const learn = await json<MeResponse>(await c.call('/api/me', { learn: 'credit' }));
  return { ...c, power, learn };
}
type User = Awaited<ReturnType<typeof newUser>>;

/** A tree of `owner` (in the given mode) with a user/assistant exchange on its trunk. */
async function treeWithNodes(owner: User, learn?: LearnPayment, req: Record<string, unknown> = {}) {
  const detail = await json<TreeDetail>(
    await owner.call('/api/trees', {
      method: 'POST',
      json: { title: 'Mine', ...req },
      ...(learn ? { learn } : {}),
    }),
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

async function usageRows(accountId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE account_id = ?1')
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('open sign-up', () => {
  it('login options no longer mention an allowlist', async () => {
    expect(await json<LoginOptionsResponse>(await client().call('/api/login-options'))).toEqual({
      configured: true,
      devMode: false,
      social: { google: false, github: false },
      turnstileSiteKey: 'site-key',
    });
  });

  it('anyone can sign up and gets a power account p_<id> and a Learn account u_<id>', async () => {
    const a = await newUser();
    const b = await newUser();
    for (const u of [a, b]) {
      expect(u.power).toMatchObject({ mode: 'power', devMode: false, operatorKeys: false });
      expect(u.learn).toMatchObject({ mode: 'simple', operatorKeys: true, paidCredit: true });
      expect(u.power.accountId).toMatch(/^p_.+/);
      expect(u.learn.accountId).toBe(`u_${u.power.accountId.slice(2)}`);
    }
    expect(a.power.accountId).not.toBe(b.power.accountId);

    const rows = await env.DB.prepare(
      'SELECT a.id, a.mode, u.email FROM accounts a JOIN auth_users u ON u.id = a.user_id WHERE a.user_id = ?1 ORDER BY a.mode',
    )
      .bind(a.power.accountId.slice(2))
      .all<{ id: string; mode: string; email: string }>();
    expect(rows.results).toEqual([
      { id: a.power.accountId, mode: 'power', email: a.power.email },
      { id: a.learn.accountId, mode: 'simple', email: a.power.email },
    ]);
  });
});

describe('switching modes', () => {
  it('power and Learn keep separate conversations for the same user', async () => {
    const u = await newUser();
    const powerTree = (await treeWithNodes(u)).detail.tree;
    const learnTree = (await treeWithNodes(u, 'credit')).detail.tree;

    const powerList = await json<TreeSummary[]>(await u.call('/api/trees'));
    const learnList = await json<TreeSummary[]>(await u.call('/api/trees', { learn: 'own-key' }));
    expect(powerList.map((t) => t.id)).toEqual([powerTree.id]);
    expect(learnList.map((t) => t.id)).toEqual([learnTree.id]);

    expect((await u.call(`/api/trees/${learnTree.id}`)).status).toBe(404);
    expect((await u.call(`/api/trees/${powerTree.id}`, { learn: 'credit' })).status).toBe(404);
    // The payment choice doesn't change the account.
    expect((await u.call(`/api/trees/${learnTree.id}`, { learn: 'own-key' })).status).toBe(200);
  });

  it('new Learn trees use tangent and the built-in tutor prompt unless one is given', async () => {
    const u = await newUser();
    const plain = await json<TreeDetail>(
      await u.call('/api/trees', { method: 'POST', json: { title: 'A' }, learn: 'own-key' }),
      201,
    );
    expect(plain.tree.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(plain.branches[0]).toMatchObject({ providerId: 'tangent', model: 'smart' });
    const own = await json<TreeDetail>(
      await u.call('/api/trees', {
        method: 'POST',
        json: { title: 'B', systemPrompt: 'Be brief.' },
        learn: 'credit',
      }),
      201,
    );
    expect(own.tree.systemPrompt).toBe('Be brief.');
    // Power mode lists the configured providers, never `tangent`.
    const providers = await json<ProviderInfo[]>(await u.call('/api/providers'));
    expect(providers.map((p) => p.id)).not.toContain('tangent');
  });
});

describe('account settings: the default system prompt', () => {
  const newTree = async (u: User, learn?: LearnPayment, body: Record<string, unknown> = {}) =>
    (
      await json<TreeDetail>(
        await u.call('/api/trees', { method: 'POST', json: body, ...(learn ? { learn } : {}) }),
        201,
      )
    ).tree;
  const patch = (u: User, systemPrompt: unknown, learn?: LearnPayment) =>
    u.call('/api/settings', {
      method: 'PATCH',
      json: { systemPrompt },
      ...(learn ? { learn } : {}),
    });

  it('power trees start with the built-in prompt, then with the saved one', async () => {
    const u = await newUser();
    expect(await json<SettingsResponse>(await u.call('/api/settings'))).toEqual({
      systemPrompt: null,
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
    expect((await newTree(u)).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);

    expect(await json<SettingsResponse>(await patch(u, 'Answer in French.'))).toEqual({
      systemPrompt: 'Answer in French.',
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
    expect((await json<SettingsResponse>(await u.call('/api/settings'))).systemPrompt).toBe(
      'Answer in French.',
    );
    expect((await newTree(u)).systemPrompt).toBe('Answer in French.');
    expect((await newTree(u, undefined, { systemPrompt: '  ' })).systemPrompt).toBe(
      'Answer in French.',
    );
    // A prompt in the request wins.
    expect((await newTree(u, undefined, { systemPrompt: 'Be brief.' })).systemPrompt).toBe(
      'Be brief.',
    );

    // A blank or null prompt goes back to the built-in one.
    expect((await json<SettingsResponse>(await patch(u, ' '))).systemPrompt).toBeNull();
    expect((await newTree(u)).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    await json<SettingsResponse>(await patch(u, 'Again.'));
    expect((await json<SettingsResponse>(await patch(u, null))).systemPrompt).toBeNull();
  });

  it('is per account: power and Learn, and other users, keep their own', async () => {
    const u = await newUser();
    const other = await newUser();
    await json<SettingsResponse>(await patch(u, 'Power prompt.'));
    expect(
      await json<SettingsResponse>(await u.call('/api/settings', { learn: 'own-key' })),
    ).toEqual({ systemPrompt: null, defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT });
    expect((await newTree(u, 'own-key')).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    await json<SettingsResponse>(await patch(u, 'Learn prompt.', 'credit'));
    expect((await newTree(u, 'credit')).systemPrompt).toBe('Learn prompt.');
    expect((await newTree(u)).systemPrompt).toBe('Power prompt.');
    expect(
      (await json<SettingsResponse>(await other.call('/api/settings'))).systemPrompt,
    ).toBeNull();
    expect((await newTree(other)).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('SIMPLE_SYSTEM_PROMPT replaces the built-in prompt of Learn only', async () => {
    const u = await newUser(authEnv({ SIMPLE_SYSTEM_PROMPT: 'Operator tutor prompt.' }));
    expect(
      (await json<SettingsResponse>(await u.call('/api/settings', { learn: 'credit' })))
        .defaultSystemPrompt,
    ).toBe('Operator tutor prompt.');
    expect((await newTree(u, 'credit')).systemPrompt).toBe('Operator tutor prompt.');
    expect((await json<SettingsResponse>(await u.call('/api/settings'))).defaultSystemPrompt).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
    expect((await newTree(u)).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    // A saved prompt still wins over the operator's.
    await json<SettingsResponse>(await patch(u, 'My own.', 'credit'));
    expect((await newTree(u, 'credit')).systemPrompt).toBe('My own.');
  });

  it('rejects malformed updates and needs a session', async () => {
    const u = await newUser();
    expect((await patch(u, 'x'.repeat(20_001))).status).toBe(400);
    expect((await patch(u, 42)).status).toBe(400);
    expect((await u.call('/api/settings', { method: 'PATCH', json: {} })).status).toBe(400);
    const anonymous = client();
    expect((await anonymous.call('/api/settings')).status).toBe(401);
  });
});

describe('ownership across users', () => {
  for (const [label, learn, review] of [
    ['power', undefined, { providerId: 'fake', model: 'fake-1' }],
    ['Learn', 'credit', { providerId: 'tangent', model: 'smart' }],
  ] as const) {
    it(`every tree, branch, node and share route answers 404 for another user's data (${label})`, async () => {
      const a = await newUser();
      const b = await newUser();
      const { detail, trunk, user, assistant } = await treeWithNodes(a, learn);
      const treeId = detail.tree.id;
      const share = await json<ShareSummary>(
        await a.call('/api/shares', {
          method: 'POST',
          json: { treeId, scope: 'tree' },
          ...(learn ? { learn } : {}),
        }),
        201,
      );

      const attempts: [string, CallInit][] = [
        [`/api/trees/${treeId}`, {}],
        [`/api/trees/${treeId}`, { method: 'PATCH', json: { title: 'Mine now' } }],
        [`/api/trees/${treeId}/backup`, {}],
        [`/api/export?treeId=${treeId}`, {}],
        [`/api/branches/${trunk.id}`, { method: 'PATCH', json: { title: 'Mine now' } }],
        [`/api/branches/${trunk.id}`, { method: 'DELETE' }],
        [`/api/branches/${trunk.id}/context`, {}],
        [`/api/branches/${trunk.id}/context?resolve=true`, {}],
        [`/api/branches/${trunk.id}/messages`, { method: 'POST', json: { content: 'hi' } }],
        [`/api/nodes/${assistant.id}/stream`, {}],
        [`/api/nodes/${assistant.id}/cancel`, { method: 'POST' }],
        [`/api/nodes/${assistant.id}/review`, { method: 'POST', json: review }],
        ['/api/branches', { method: 'POST', json: { fromNodeId: user.id } }],
        ['/api/shares', { method: 'POST', json: { treeId, scope: 'tree' } }],
        [`/api/shares/${share.id}`, { method: 'PATCH', json: { title: 'Mine now' } }],
        [`/api/shares/${share.id}/republish`, { method: 'POST' }],
        [`/api/shares/${share.id}/revoke`, { method: 'POST' }],
        [`/api/trees/${treeId}`, { method: 'DELETE' }],
      ];
      // B tries in both modes: neither of B's accounts owns A's data.
      for (const bLearn of [undefined, 'credit', 'own-key'] as const) {
        for (const [path, init] of attempts) {
          const res = await b.call(path, { ...init, ...(bLearn ? { learn: bLearn } : {}) });
          expect(res.status, `${bLearn ?? 'power'} ${init.method ?? 'GET'} ${path}`).toBe(404);
          expect(await errorCode(res)).toBe('not_found');
        }
      }
      for (const bLearn of [undefined, 'credit'] as const) {
        const opts = bLearn ? { learn: bLearn } : {};
        const trees = await json<TreeSummary[]>(await b.call('/api/trees', opts));
        expect(trees.some((t) => t.id === treeId)).toBe(false);
        const shares = await json<ShareSummary[]>(await b.call('/api/shares', opts));
        expect(shares.some((s) => s.id === share.id)).toBe(false);
      }

      // Nothing changed, and A still has full access.
      const opts = learn ? { learn } : {};
      const after = await json<TreeDetail>(await a.call(`/api/trees/${treeId}`, opts));
      expect(after.tree.title).toBe('Mine');
      expect(after.branches).toHaveLength(1);
      expect(after.branches[0]!.title).toBe(trunk.title);
      expect(after.nodes).toHaveLength(2);
      const aShares = await json<ShareSummary[]>(await a.call('/api/shares', opts));
      expect(aShares.find((s) => s.id === share.id)).toMatchObject({
        state: 'active',
        title: null,
      });
      const renamed = await json<Branch>(
        await a.call(`/api/branches/${trunk.id}`, {
          method: 'PATCH',
          json: { title: 'Primes' },
          ...opts,
        }),
      );
      expect(renamed.title).toBe('Primes');
      const child = await json<Branch>(
        await a.call('/api/branches', {
          method: 'POST',
          json: { fromNodeId: assistant.id },
          ...opts,
        }),
        201,
      );
      expect(child.treeId).toBe(treeId);
      expect((await a.call(`/api/branches/${trunk.id}/context`, opts)).status).toBe(200);
    });
  }
});

describe('Learn mode on paid credit', () => {
  it('402 without credit; after a grant the send streams and is charged cost + fee + 10%', async () => {
    const u = await newUser();
    const { trunk, assistant } = await treeWithNodes(u, 'credit');

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
    ] as [string, CallInit][]) {
      const res = await u.call(path, { ...init, learn: 'credit' });
      expect(res.status, path).toBe(402);
      expect(await errorCode(res)).toBe('payment_required');
    }
    // A plain context plan costs nothing and stays available.
    expect((await u.call(`/api/branches/${trunk.id}/context`, { learn: 'credit' })).status).toBe(
      200,
    );

    await grantCredit(env.DB, {
      accountId: u.learn.accountId,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      stripeRef: null,
      note: 'test',
    });
    const res = await u.call(`/api/branches/${trunk.id}/messages`, {
      method: 'POST',
      json: { content: 'Explain primes' },
      learn: 'credit',
    });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events[0]?.type).toBe('start');
    expect(events.at(-1)?.type).toBe('done');

    const rows = await env.DB.prepare(
      'SELECT status, cost_nanos, charge_micros, provider_id FROM usage_events WHERE account_id = ?1',
    )
      .bind(u.learn.accountId)
      .all<{ status: string; cost_nanos: number; charge_micros: number; provider_id: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    // The fake provider reports $0.001234 per call: 1,234,000 nano-USD; + OpenRouter's 5.5%
    // purchase fee, then +10%, rounded up to micro-USD (1432.057 → 1433).
    const charge = Math.ceil((1_234_000 * 10_550 * 11_000) / 100_000_000_000);
    expect(charge).toBe(1433);
    for (const row of rows.results) {
      expect(row).toEqual({
        status: 'settled',
        cost_nanos: 1_234_000,
        charge_micros: charge,
        provider_id: 'tangent',
      });
    }
  });

  it('is hidden without billing: credit falls back to the own-key mode', async () => {
    const e = authEnv({ STRIPE_SECRET_KEY: '' });
    const u = await newUser(e);
    expect(u.learn).toMatchObject({ mode: 'simple', operatorKeys: false, paidCredit: false });
    const res = await u.call('/api/billing', { learn: 'credit' });
    expect(await json<{ enabled: boolean }>(res)).toMatchObject({ enabled: false });
  });

  it('billing stays forbidden in power mode', async () => {
    const u = await newUser();
    const res = await u.call('/api/billing');
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('forbidden');
  });
});

describe("Learn mode on the user's own OpenRouter key", () => {
  /** The real shape of `tangent`: OpenRouter-like, on the operator's OPENROUTER_SIMPLE_API_KEY. */
  const ownKeyEnv = () =>
    authEnv({
      SIMPLE_PROVIDER: JSON.stringify({
        id: 'tangent',
        kind: 'anthropic',
        label: 'Tangent',
        baseUrl: MOCK_UPSTREAM,
        apiKeySecret: 'OPENROUTER_SIMPLE_API_KEY',
        defaultModel: 'smart',
        models: [
          { id: 'smart', label: 'Smart' },
          { id: 'simple', label: 'Simple' },
        ],
      }),
      OPENROUTER_SIMPLE_API_KEY: 'sk-ant-goodOPERATOR-0123',
    });

  it('sends without credit and without metering (the Durable Object path)', async () => {
    const u = await newUser();
    const { trunk } = await treeWithNodes(u, 'own-key');
    const res = await u.call(`/api/branches/${trunk.id}/messages`, {
      method: 'POST',
      json: { content: 'Explain primes' },
      learn: 'own-key',
    });
    expect(res.status).toBe(200);
    expect(parseSse(await res.text()).at(-1)?.type).toBe('done');
    expect(await usageRows(u.learn.accountId)).toBe(0);
  });

  // Reviews stream from the Worker itself, so they run with this test's env
  // (the Durable Object always has the vitest.config.ts bindings). Sends use
  // the same registryFor.
  it("never spends the operator's key or touches the ledger", async () => {
    const u = await newUser(ownKeyEnv());
    expect(u.learn.paidCredit).toBe(true);
    const { assistant } = await treeWithNodes(u, 'own-key');
    const send = (learn: LearnPayment = 'own-key') =>
      u.call(`/api/nodes/${assistant.id}/review`, {
        method: 'POST',
        json: { providerId: 'tangent', model: 'smart' },
        learn,
      });

    // No key yet: asked for one (not 402), and the operator's key is not offered.
    const providers = await json<ProviderInfo[]>(
      await u.call('/api/providers', { learn: 'own-key' }),
    );
    expect(providers).toEqual([
      expect.objectContaining({ id: 'tangent', available: false, keySource: null }),
    ]);
    const noKey = await send();
    expect(noKey.status).toBe(401);
    expect(await errorCode(noKey)).toBe('key_required');

    // Learn stores only the OpenRouter entry.
    const powerOnly = await u.call('/api/key', {
      method: 'POST',
      json: { provider: 'ant', apiKey: 'sk-ant-goodLEARNER-0123456789' },
      learn: 'own-key',
    });
    expect(powerOnly.status).toBe(400);
    const saved = await u.call('/api/key', {
      method: 'POST',
      json: { provider: 'openrouter', apiKey: 'sk-ant-goodLEARNER-0123456789' },
      learn: 'own-key',
    });
    expect(saved.status, await saved.text()).toBe(204);
    expect(
      await json<{ providers: string[] }>(await u.call('/api/key/status', { learn: 'own-key' })),
    ).toMatchObject({ hasKey: true, providers: ['openrouter'] });

    // No credit at all, yet the send streams, on the user's key.
    const res = await send();
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.at(-1)?.type).toBe('done');
    expect(replyText(events)).toBe('key=LEARNER-0123456789');
    expect(await usageRows(u.learn.accountId)).toBe(0);

    // Paid credit ignores the key: 402 without credit.
    const paid = await send('credit');
    expect(paid.status).toBe(402);
    expect(await errorCode(paid)).toBe('payment_required');
  });
});

describe('power-mode server keys', () => {
  const serverKeyEnv = () =>
    authEnv({
      PROVIDERS: JSON.stringify([
        {
          id: 'fake',
          kind: 'fake',
          label: 'Fake',
          defaultModel: 'fake-1',
          models: [{ id: 'fake-1', label: 'Fake 1' }],
        },
        {
          id: 'srv',
          kind: 'anthropic',
          label: 'Server',
          baseUrl: MOCK_UPSTREAM,
          apiKeySecret: 'ANTHROPIC_API_KEY',
          defaultModel: 'claude-test',
          models: [{ id: 'claude-test', label: 'Claude Test' }],
        },
        {
          // Misconfigured on purpose: the paid-Learn key must never serve power mode.
          id: 'leak',
          kind: 'anthropic',
          label: 'Leak',
          baseUrl: MOCK_UPSTREAM,
          apiKeySecret: 'OPENROUTER_SIMPLE_API_KEY',
          defaultModel: 'claude-test',
          models: [{ id: 'claude-test', label: 'Claude Test' }],
        },
      ]),
      ANTHROPIC_API_KEY: 'sk-ant-goodSERVER-0123',
      OPENROUTER_SIMPLE_API_KEY: 'sk-ant-goodOPERATOR-0123',
    });

  /** A review streams from the Worker, so it runs with this env (see the Learn own-key test). */
  async function sendOnSrv(u: User) {
    const { assistant } = await treeWithNodes(u, undefined, {
      providerId: 'srv',
      model: 'claude-test',
    });
    return u.call(`/api/nodes/${assistant.id}/review`, {
      method: 'POST',
      json: { providerId: 'srv', model: 'claude-test' },
    });
  }

  it('a signed-in user never spends them and is asked for their own key', async () => {
    const u = await newUser(serverKeyEnv(), 'owner@example.com');
    expect(u.power.operatorKeys).toBe(false);
    const providers = await json<ProviderInfo[]>(await u.call('/api/providers'));
    for (const id of ['srv', 'leak']) {
      expect(providers.find((p) => p.id === id)).toMatchObject({
        available: false,
        keySource: null,
      });
    }
    const res = await sendOnSrv(u);
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('key_required');

    // Their own key works, and is the one used.
    const saved = await u.call('/api/key', {
      method: 'POST',
      json: { provider: 'srv', apiKey: 'sk-ant-goodPOWERUSER-0123' },
    });
    expect(saved.status, await saved.text()).toBe(204);
    const own = await sendOnSrv(u);
    expect(own.status).toBe(200);
    expect(replyText(parseSse(await own.text()))).toBe('key=POWERUSER-0123');
  });

  it('only the local dev bypass uses them, and never the paid-Learn key', async () => {
    const dev = client(authEnv({ BETTER_AUTH_SECRET: '', DEV_ALLOW_NO_AUTH: 'true' }));
    const devEnv = {
      ...serverKeyEnv(),
      BETTER_AUTH_SECRET: '',
      DEV_ALLOW_NO_AUTH: 'true',
    } as AppEnv;
    const me = await json<MeResponse>(await dev.call('/api/me', {}, devEnv));
    expect(me).toMatchObject({ devMode: true, mode: 'power', operatorKeys: true });
    const providers = await json<ProviderInfo[]>(await dev.call('/api/providers', {}, devEnv));
    expect(providers.find((p) => p.id === 'srv')).toMatchObject({
      available: true,
      keySource: 'server',
    });
    expect(providers.find((p) => p.id === 'leak')).toMatchObject({ available: false });
    const detail = await json<TreeDetail>(
      await dev.call(
        '/api/trees',
        { method: 'POST', json: { title: 'Dev', providerId: 'srv', model: 'claude-test' } },
        devEnv,
      ),
      201,
    );
    const trunk = detail.branches[0]!;
    const user = makeNode(trunk, 0, null, { role: 'user', content: 'Hi' });
    const assistant = makeNode(trunk, 1, user.id, { role: 'assistant', content: 'Hello' });
    await createD1Repositories(env.DB).trees.appendNodes(
      [user, assistant],
      new Date().toISOString(),
    );
    const res = await dev.call(
      `/api/nodes/${assistant.id}/review`,
      { method: 'POST', json: { providerId: 'srv', model: 'claude-test' } },
      devEnv,
    );
    expect(res.status).toBe(200);
    expect(replyText(parseSse(await res.text()))).toBe('key=SERVER-0123');
  });
});

describe('account deletion', () => {
  async function count(sql: string, ...binds: unknown[]): Promise<number> {
    const row = await env.DB.prepare(sql)
      .bind(...binds)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** A real customer in the Stripe mock, linked to the user as the first checkout would. */
  async function linkStripeCustomer(userId: string): Promise<string> {
    const res = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_test_x' },
      body: new URLSearchParams({ email: `${userId}@example.org` }),
    });
    const { id } = (await res.json()) as { id: string };
    await env.DB.prepare('UPDATE auth_users SET stripe_customer_id = ?1 WHERE id = ?2')
      .bind(id, userId)
      .run();
    return id;
  }

  it('deletes both accounts, their data, sign-in and Stripe customer; keeps the ledger and other users', async () => {
    const a = await newUser();
    const other = await newUser();
    const userId = a.power.accountId.slice(2);
    const { detail: powerTree } = await treeWithNodes(a);
    const { detail: learnTree } = await treeWithNodes(a, 'credit');
    const { detail: otherTree } = await treeWithNodes(other);
    const share = await json<ShareSummary>(
      await a.call('/api/shares', {
        method: 'POST',
        json: { treeId: powerTree.tree.id, scope: 'tree' },
      }),
      201,
    );
    await json(await a.call('/api/settings', { method: 'PATCH', json: { systemPrompt: 'Mine' } }));
    await grantCredit(env.DB, {
      accountId: a.learn.accountId,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      stripeRef: null,
      note: 'test',
    });
    const customerId = await linkStripeCustomer(userId);

    // The confirmation must be the user's own email.
    const wrong = await a.call('/api/account', {
      method: 'DELETE',
      json: { confirmEmail: 'x@example.org' },
    });
    expect(wrong.status).toBe(400);
    expect(await count('SELECT COUNT(*) AS n FROM auth_users WHERE id = ?1', userId)).toBe(1);
    // And cross-site requests are refused outright.
    const forged = await a.call('/api/account', {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'cross-site' },
      json: { confirmEmail: a.power.email },
    });
    expect(forged.status).toBe(403);

    const res = await a.call('/api/account', {
      method: 'DELETE',
      json: { confirmEmail: a.power.email!.toUpperCase() },
    });
    expect(res.status, await res.clone().text()).toBe(204);
    const cleared = res.headers.getSetCookie().join('\n');
    expect(cleared).toMatch(/__Secure-tangent\.session_token=;.*Max-Age=0/);
    expect(cleared).toMatch(/__Host-llmkey=;.*Max-Age=0/);

    const ids = [a.power.accountId, a.learn.accountId];
    for (const [table, column] of [
      ['trees', 'account_id'],
      ['shares', 'account_id'],
      ['account_settings', 'account_id'],
      ['accounts', 'id'],
    ] as const) {
      expect(
        await count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (?1, ?2)`, ...ids),
        table,
      ).toBe(0);
    }
    for (const tree of [powerTree, learnTree]) {
      for (const table of ['branches', 'nodes']) {
        expect(
          await count(`SELECT COUNT(*) AS n FROM ${table} WHERE tree_id = ?1`, tree.tree.id),
          table,
        ).toBe(0);
      }
    }
    for (const table of ['auth_sessions', 'auth_accounts', 'auth_passkeys']) {
      expect(
        await count(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?1`, userId),
        table,
      ).toBe(0);
    }
    expect(await count('SELECT COUNT(*) AS n FROM auth_users WHERE id = ?1', userId)).toBe(0);
    // Payment records stay for accounting; they hold no conversation content.
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM credit_grants WHERE account_id = ?1',
        a.learn.accountId,
      ),
    ).toBe(1);

    const calls = (await (
      await fetch(`https://api.stripe.com/__mock/calls?path=/v1/customers/${customerId}`)
    ).json()) as { method: string }[];
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);

    // The share link is gone and the old session no longer signs anyone in.
    expect((await a.call(`/s/${share.token}`)).status).toBe(404);
    expect((await a.call('/api/me')).status).toBe(401);

    // Someone else's data is untouched.
    expect((await other.call(`/api/trees/${otherTree.tree.id}`)).status).toBe(200);
  });

  it('signing up again with the same email starts from nothing', async () => {
    const email = `again-${Math.random().toString(36).slice(2, 8)}@example.org`;
    const first = await newUser(authEnv(), email);
    await treeWithNodes(first);
    expect(
      (await first.call('/api/account', { method: 'DELETE', json: { confirmEmail: email } }))
        .status,
    ).toBe(204);

    const second = await newUser(authEnv(), email);
    expect(second.power.accountId).not.toBe(first.power.accountId);
    expect(await json<TreeSummary[]>(await second.call('/api/trees'))).toEqual([]);
  });
});
