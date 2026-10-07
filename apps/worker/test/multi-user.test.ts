import {
  DEFAULT_SYSTEM_PROMPT,
  type ApiError,
  type BillingSummary,
  type Branch,
  type LearnPayment,
  type LoginOptionsResponse,
  type MeResponse,
  type MembershipInfo,
  type NodeLink,
  type ProviderInfo,
  type SettingsResponse,
  type ShareSummary,
  type StreamEvent,
  type TreeDetail,
  type TreeSummary,
} from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { deleteUser } from '../src/auth/delete-account.js';
import { grantCredit } from '../src/billing/ledger.js';
import { rememberCustomer } from '../src/billing/payments/customers.js';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AppEnv } from '../src/env.js';
import { makeNode } from './fixtures.js';
import { insertSubscription, insertUsage } from './mocks/billing-helpers.js';
import { authEnv, client, type CallInit } from './session-client.js';

/** The Anthropic-style mock upstream of vitest.config.ts: `sk-ant-good…` keys work, replies echo `key=<rest>`. */
const MOCK_UPSTREAM = 'https://llm.test';

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
      expect(u.learn).toMatchObject({ mode: 'simple', operatorKeys: false, builtInCredit: true });
      expect(u.power).toMatchObject({ builtInCredit: true });
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

  it('new Learn trees use the built-in endpoint and the tutor prompt unless one is given', async () => {
    const u = await newUser();
    const plain = await json<TreeDetail>(
      await u.call('/api/trees', { method: 'POST', json: { title: 'A' }, learn: 'own-key' }),
      201,
    );
    expect(plain.tree.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    // Learn pays per request: its branches are written `own-key`, whatever the payment.
    expect(plain.branches[0]).toMatchObject({
      providerId: 'openrouter',
      model: 'smart',
      funding: 'own-key',
    });
    const own = await json<TreeDetail>(
      await u.call('/api/trees', {
        method: 'POST',
        json: { title: 'B', systemPrompt: 'Be brief.' },
        learn: 'credit',
      }),
      201,
    );
    expect(own.tree.systemPrompt).toBe('Be brief.');
    expect(own.branches[0]).toMatchObject({ providerId: 'openrouter', funding: 'own-key' });
    // Power mode lists the configured providers, then the built-in endpoint on Tangent credit.
    const providers = await json<ProviderInfo[]>(await u.call('/api/providers'));
    expect(providers.map((p) => `${p.id}:${p.funding}`)).toEqual([
      'fake:own-key',
      'slow:own-key',
      'ant:own-key',
      'openrouter:credit',
    ]);
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
    ['Learn', 'credit', { providerId: 'openrouter', model: 'smart' }],
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
      const link = await json<NodeLink>(
        await a.call('/api/links', {
          method: 'POST',
          json: { fromNodeId: user.id, toNodeId: assistant.id, note: 'mine' },
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
        ['/api/links', { method: 'POST', json: { fromNodeId: user.id, toNodeId: assistant.id } }],
        [`/api/links/${link.id}`, { method: 'PATCH', json: { note: 'Mine now' } }],
        [`/api/links/${link.id}`, { method: 'DELETE' }],
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
      expect(after.links).toEqual([link]);
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
    // With the pool off: a send on spent credit would otherwise move to the pool
    // (pool-routing.test.ts); a review never does.
    const u = await newUser(authEnv({ POOL_ENABLED: 'false' }));
    const { trunk, assistant } = await treeWithNodes(u, 'credit');

    for (const [path, init] of [
      [
        `/api/branches/${trunk.id}/messages`,
        { method: 'POST', json: { content: 'Explain primes' } },
      ],
      [
        `/api/nodes/${assistant.id}/review`,
        { method: 'POST', json: { providerId: 'openrouter', model: 'smart' } },
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
      providerRef: null,
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
        provider_id: 'openrouter',
      });
    }
  });

  it('is hidden without billing: credit falls back to the own-key mode', async () => {
    const e = authEnv({ PAYMENT_PROVIDER: 'polar' });
    const u = await newUser(e);
    expect(u.learn).toMatchObject({ mode: 'simple', operatorKeys: false, builtInCredit: false });
    const res = await u.call('/api/billing', { learn: 'credit' });
    expect(await json<{ enabled: boolean }>(res)).toMatchObject({ enabled: false });
  });

  it('billing answers in power mode too, with the same per-user credit', async () => {
    const u = await newUser();
    await grantCredit(env.DB, {
      accountId: u.learn.accountId,
      kind: 'adjustment',
      amountMicros: 1_500_000,
      providerRef: null,
    });
    for (const learn of [undefined, 'credit', 'own-key'] as const) {
      const summary = await json<BillingSummary>(
        await u.call('/api/billing', learn ? { learn } : {}),
      );
      expect(summary).toMatchObject({ builtInCredit: true, balanceMicros: 1_500_000 });
    }
  });
});

describe('power mode with the built-in provider (Tangent credit)', () => {
  /** A route on Tangent credit: the built-in endpoint, paid from the user's credit. */
  const CREDIT = { providerId: 'openrouter', funding: 'credit' } as const;

  async function powerTree(
    u: User,
    route: { providerId: string; funding?: 'own-key' | 'credit' },
    model: string,
  ) {
    return treeWithNodes(u, undefined, { ...route, model });
  }

  it('lists the built-in endpoint on credit after the own providers, with open models, when it is offered', async () => {
    const u = await newUser();
    const providers = await json<ProviderInfo[]>(await u.call('/api/providers'));
    expect(providers.map((p) => p.id)).toEqual(['fake', 'slow', 'ant', 'openrouter']);
    expect(providers.at(-1)).toMatchObject({
      id: 'openrouter',
      funding: 'credit',
      label: 'Tangent credit',
      available: true,
      acceptsUserKey: false,
      openModels: true,
      models: [
        { id: 'smart', label: 'Smart (suggested)' },
        { id: 'simple', label: 'Simple (suggested)' },
      ],
    });
    expect(providers.filter((p) => p.openModels).map((p) => p.id)).toEqual(['openrouter']);

    // Not offered without billing, or without the operator's key.
    for (const e of [
      authEnv({ PAYMENT_PROVIDER: 'polar' }),
      authEnv({ SIMPLE_PROVIDER: '', OPENROUTER_SIMPLE_API_KEY: '' }),
    ]) {
      const v = await newUser(e);
      expect(v.power.builtInCredit).toBe(false);
      const ids = (await json<ProviderInfo[]>(await v.call('/api/providers'))).map((p) => p.id);
      expect(ids).toEqual(['fake', 'slow', 'ant']);
    }
  });

  it("meters sends on Tangent credit to the user's ledger u_<userId>; BYOK sends are not metered", async () => {
    const u = await newUser();
    const userId = u.power.accountId.slice(2);
    const onTangent = await powerTree(u, CREDIT, 'smart');
    const send = (branchId: string) =>
      u.call(`/api/branches/${branchId}/messages`, {
        method: 'POST',
        json: { content: 'Explain primes' },
      });

    const short = await send(onTangent.trunk.id);
    expect(short.status).toBe(402);
    expect(await errorCode(short)).toBe('payment_required');

    // Credit is per user: a Learn grant pays for power calls.
    await grantCredit(env.DB, {
      accountId: `u_${userId}`,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
    });
    const res = await send(onTangent.trunk.id);
    expect(res.status).toBe(200);
    expect(parseSse(await res.text()).at(-1)?.type).toBe('done');
    const metered = await usageRows(`u_${userId}`);
    expect(metered).toBeGreaterThan(0);
    expect(await usageRows(u.power.accountId)).toBe(0);

    // A provider of the user's own (here the keyless fake) is never metered.
    const own = await powerTree(u, { providerId: 'fake' }, 'fake-1');
    const free = await send(own.trunk.id);
    expect(free.status).toBe(200);
    expect(parseSse(await free.text()).at(-1)?.type).toBe('done');
    expect(await usageRows(`u_${userId}`)).toBe(metered);

    const billing = await json<BillingSummary>(await u.call('/api/billing'));
    expect(billing.balanceMicros).toBeLessThan(1_000_000);
  });

  it('a review is metered iff the reviewer is on Tangent credit', async () => {
    const u = await newUser();
    const userId = u.power.accountId.slice(2);
    const { assistant } = await powerTree(u, { providerId: 'fake' }, 'fake-1');
    const review = (route: { providerId: string; funding?: 'own-key' | 'credit' }, model: string) =>
      u.call(`/api/nodes/${assistant.id}/review`, {
        method: 'POST',
        json: { ...route, model },
      });
    expect((await review({ providerId: 'fake' }, 'fake-1')).status).toBe(200);
    const onCredit = await review(CREDIT, 'smart');
    expect(onCredit.status).toBe(402);
    expect(await errorCode(onCredit)).toBe('payment_required');
    await grantCredit(env.DB, {
      accountId: `u_${userId}`,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
    });
    expect((await review(CREDIT, 'smart')).status).toBe(200);
    expect(await usageRows(`u_${userId}`)).toBe(1);
  });

  it('caps metered calls in flight per user (USAGE_MAX_PENDING, 3): 429, no new row; BYOK is not capped', async () => {
    const u = await newUser();
    const ledger = u.learn.accountId;
    await grantCredit(env.DB, {
      accountId: ledger,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
    });
    const onTangent = await powerTree(u, CREDIT, 'smart');
    const own = await powerTree(u, { providerId: 'fake' }, 'fake-1');
    const send = (branchId: string) =>
      u.call(`/api/branches/${branchId}/messages`, {
        method: 'POST',
        json: { content: 'Explain primes' },
      });
    // Two calls still in flight (e.g. in the other app): one more may start.
    const inFlight = [
      await insertUsage(env, { accountId: ledger }),
      await insertUsage(env, { accountId: ledger }),
    ];
    const ok = await send(onTangent.trunk.id);
    expect(ok.status).toBe(200);
    expect(parseSse(await ok.text()).at(-1)?.type).toBe('done');

    inFlight.push(await insertUsage(env, { accountId: ledger }));
    const rows = await usageRows(ledger);
    const capped = await send(onTangent.trunk.id);
    expect(capped.status).toBe(429);
    expect(await errorCode(capped)).toBe('rate_limited');
    expect(await usageRows(ledger)).toBe(rows);

    // A send on the user's own provider doesn't touch credit, so it isn't capped.
    const free = await send(own.trunk.id);
    expect(free.status).toBe(200);
    expect(parseSse(await free.text()).at(-1)?.type).toBe('done');
    expect(await usageRows(ledger)).toBe(rows);
  });

  it("a review of a reply on Tangent credit needs credit whoever reviews: its summaries run on the branch's route", async () => {
    const u = await newUser();
    const { assistant } = await powerTree(u, CREDIT, 'smart');
    const res = await u.call(`/api/nodes/${assistant.id}/review`, {
      method: 'POST',
      json: { providerId: 'fake', model: 'fake-1' },
    });
    expect(res.status).toBe(402);
    expect(await errorCode(res)).toBe('payment_required');
  });

  it('rate limits built-in calls per user, across both apps (5/min in tests)', async () => {
    const u = await newUser();
    await grantCredit(env.DB, {
      accountId: u.learn.accountId,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
    });
    const power = await powerTree(u, CREDIT, 'smart');
    const learn = await treeWithNodes(u, 'credit');
    const resolve = (branchId: string, init: CallInit = {}) =>
      u.call(`/api/branches/${branchId}/context?resolve=true`, init);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await resolve(power.trunk.id)).status);
      statuses.push((await resolve(learn.trunk.id, { learn: 'credit' })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    // A power branch on the user's own provider has its own (cookie) bucket: none here.
    const own = await powerTree(u, { providerId: 'fake' }, 'fake-1');
    expect((await resolve(own.trunk.id)).status).toBe(200);
  });

  it('accepts an unlisted model only on an openModels provider', async () => {
    const u = await newUser();
    await grantCredit(env.DB, {
      accountId: u.learn.accountId,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
    });
    const open = await powerTree(u, CREDIT, 'vendor/any-model:free');
    const ok = await u.call(`/api/branches/${open.trunk.id}/messages`, {
      method: 'POST',
      json: { content: 'hi' },
    });
    expect(ok.status).toBe(200);
    expect(parseSse(await ok.text()).at(-1)?.type).toBe('done');
    const row = await env.DB.prepare('SELECT model FROM usage_events WHERE account_id = ?1')
      .bind(u.learn.accountId)
      .first<{ model: string }>();
    expect(row?.model).toBe('vendor/any-model:free');

    for (const [route, model] of [
      [CREDIT, 'not a model id'],
      [{ providerId: 'fake' }, 'vendor/any-model:free'],
    ] as const) {
      const t = await powerTree(u, route, model);
      const res = await u.call(`/api/branches/${t.trunk.id}/messages`, {
        method: 'POST',
        json: { content: 'hi' },
      });
      expect(res.status, `${route.providerId} ${model}`).toBe(400);
      expect(await errorCode(res)).toBe('bad_request');
    }
  });
});

describe('membership', () => {
  const WAIVER = 'let-me-in';
  /** The membership sold and required, with a waiver code. */
  const memberEnv = (overrides: Partial<AppEnv> = {}) =>
    authEnv({
      ANNUAL_FEE_ENABLED: 'true',
      MEMBERSHIP_WAIVER_CODE: WAIVER,
      ...overrides,
    });

  /** The three generating requests on `owner`'s tree (power on the keyless fake provider, or Learn). */
  async function generating(owner: User, learn?: LearnPayment) {
    const { trunk, assistant } = learn
      ? await treeWithNodes(owner, learn)
      : await treeWithNodes(owner, undefined, { providerId: 'fake', model: 'fake-1' });
    const review = learn
      ? { providerId: 'openrouter', model: 'smart' }
      : { providerId: 'fake', model: 'fake-1' };
    return {
      trunk,
      requests: [
        [`/api/branches/${trunk.id}/messages`, { method: 'POST', json: { content: 'Hi' } }],
        [`/api/nodes/${assistant.id}/review`, { method: 'POST', json: review }],
        [`/api/branches/${trunk.id}/context?resolve=true`, {}],
      ] as [string, CallInit][],
    };
  }

  it('/api/me carries it in both modes; not required without the price id', async () => {
    const free = await newUser();
    for (const me of [free.power, free.learn]) {
      expect(me.membership).toEqual({
        required: false,
        status: 'inactive',
        subscriptionStatus: null,
        periodEnd: null,
        cancelAtPeriodEnd: false,
        priceCents: 1000,
        includedCreditCents: 0,
      } satisfies MembershipInfo);
    }
    const u = await newUser(memberEnv());
    for (const me of [u.power, u.learn])
      expect(me.membership).toMatchObject({ required: true, status: 'inactive' });
  });

  it('402 membership_required on the three generating routes on own keys, in both apps, before the credit check', async () => {
    // With the pool off: with it on, a Learn send on credit without a balance moves to the
    // pool instead (annual-fee.test.ts).
    const u = await newUser(memberEnv({ POOL_ENABLED: 'false' }));
    // Learn on credit needs no membership: it is checked for its balance only (none here:
    // 402 payment_required).
    {
      const { requests } = await generating(u, 'credit');
      for (const [path, init] of requests) {
        const res = await u.call(path, { ...init, learn: 'credit' });
        expect(res.status, `credit ${path}`).toBe(402);
        expect(await errorCode(res), `credit ${path}`).toBe('payment_required');
      }
    }
    for (const learn of ['own-key', undefined] as const) {
      const { trunk, requests } = await generating(u, learn);
      for (const [path, init] of requests) {
        const res = await u.call(path, { ...init, ...(learn ? { learn } : {}) });
        expect(res.status, `${learn ?? 'power'} ${path}`).toBe(402);
        expect(await errorCode(res)).toBe('membership_required');
      }
      // Reading, exporting and settings stay open: nobody is locked out of their data.
      const opts = learn ? { learn } : {};
      for (const path of [
        '/api/trees',
        `/api/trees/${trunk.treeId}`,
        `/api/trees/${trunk.treeId}/backup`,
        `/api/export?treeId=${trunk.treeId}&scope=tree&format=md`,
        `/api/branches/${trunk.id}/context`,
        '/api/settings',
        '/api/billing',
        '/api/providers',
      ]) {
        expect((await u.call(path, opts)).status, `${learn ?? 'power'} ${path}`).toBe(200);
      }
    }
    // Another user's ids are still 404, not 402.
    const other = await newUser(memberEnv());
    const { trunk } = await generating(u);
    const res = await other.call(`/api/branches/${trunk.id}/messages`, {
      method: 'POST',
      json: { content: 'Hi' },
    });
    expect(res.status).toBe(404);
  });

  it('a paid membership opens generating; credit is checked next', async () => {
    // With the pool off, so spent credit answers 402 (pool-routing.test.ts covers the fallback).
    const u = await newUser(memberEnv({ POOL_ENABLED: 'false' }));
    await insertSubscription(env, u.power.accountId.slice(2), 'past_due');
    expect(
      (await json<MeResponse>(await u.call('/api/me', { learn: 'credit' }))).membership,
    ).toMatchObject({ required: true, status: 'active', subscriptionStatus: 'past_due' });
    const { requests } = await generating(u);
    const res = await u.call(...requests[0]!);
    expect(res.status).toBe(200);
    expect(parseSse(await res.text()).at(-1)?.type).toBe('done');
    // Learn on credit, without any: now the credit check answers.
    const learn = await generating(u, 'credit');
    const short = await u.call(learn.requests[0]![0], {
      ...learn.requests[0]![1],
      learn: 'credit',
    });
    expect(short.status).toBe(402);
    expect(await errorCode(short)).toBe('payment_required');
  });

  it('the waiver code opens generating, in both apps', async () => {
    const u = await newUser(memberEnv());
    const wrong = await u.call('/api/billing/membership/waiver', {
      method: 'POST',
      json: { code: 'guess' },
    });
    expect(wrong.status).toBe(403);
    const info = await json<MembershipInfo>(
      await u.call('/api/billing/membership/waiver', {
        method: 'POST',
        json: { code: WAIVER },
        learn: 'own-key',
      }),
    );
    expect(info).toMatchObject({ required: true, status: 'waived' });
    expect((await json<MeResponse>(await u.call('/api/me'))).membership.status).toBe('waived');
    const { requests } = await generating(u);
    const res = await u.call(...requests[1]!);
    expect(res.status).toBe(200);
  });
});

describe("Learn mode on the user's own OpenRouter key", () => {
  /** The real shape of the built-in provider: OpenRouter-like, on the operator's OPENROUTER_SIMPLE_API_KEY. */
  const ownKeyEnv = () =>
    authEnv({
      SIMPLE_PROVIDER: JSON.stringify({
        id: 'openrouter',
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

  it('asks for the OpenRouter key by name when a send has none (401 key_required)', async () => {
    const u = await newUser(ownKeyEnv());
    const { trunk } = await treeWithNodes(u, 'own-key');
    const res = await u.call(`/api/branches/${trunk.id}/messages`, {
      method: 'POST',
      json: { content: 'Explain primes' },
      learn: 'own-key',
    });
    expect(res.status).toBe(401);
    // Not the provider's label ("Tangent"): Learn runs on the user's OpenRouter key.
    expect(((await res.json()) as ApiError).error).toEqual({
      code: 'key_required',
      message: 'Add your OpenRouter API key to continue this conversation.',
    });
  });

  // Reviews stream from the Worker itself, so they run with this test's env
  // (the Durable Object always has the vitest.config.ts bindings). Sends use
  // the same registryFor.
  it("never spends the operator's key or touches the ledger", async () => {
    const u = await newUser(ownKeyEnv());
    expect(u.learn.builtInCredit).toBe(true);
    const { assistant } = await treeWithNodes(u, 'own-key');
    const send = (learn: LearnPayment = 'own-key') =>
      u.call(`/api/nodes/${assistant.id}/review`, {
        method: 'POST',
        json: { providerId: 'openrouter', model: 'smart' },
        learn,
      });

    // No key yet: asked for one (not 402), and the operator's key is not offered.
    const providers = await json<ProviderInfo[]>(
      await u.call('/api/providers', { learn: 'own-key' }),
    );
    expect(providers).toEqual([
      expect.objectContaining({ id: 'openrouter', available: false, keySource: null }),
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

  it('deletes both accounts, their data, sign-in and billing customer; keeps the ledger and other users', async () => {
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
      providerRef: null,
      note: 'test',
    });
    await rememberCustomer(env.DB, 'fake', userId, 'cust_gone');

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

    expect(
      await count('SELECT COUNT(*) AS n FROM billing_customers WHERE user_id = ?1', userId),
    ).toBe(0);

    // The share link is gone and the old session no longer signs anyone in.
    expect((await a.call(`/s/${share.token}`)).status).toBe(404);
    expect((await a.call('/api/me')).status).toBe(401);

    // Someone else's data is untouched.
    expect((await other.call(`/api/trees/${otherTree.tree.id}`)).status).toBe(200);
  });

  it('ends the subscription at the payment provider and forgets the billing rows', async () => {
    const a = await newUser();
    const userId = a.power.accountId.slice(2);
    await insertSubscription(env, userId, 'active');
    await rememberCustomer(env.DB, 'fake', userId, 'cust_del');
    const deleted = await deleteUser(
      { ...env, FAKE_PAYMENTS: JSON.stringify({ deleteResult: 'deleted' }) } as AppEnv,
      userId,
    );
    expect(deleted.billingCustomerDeleted).toBe(true);
    for (const table of ['billing_subscriptions', 'billing_customers'])
      expect(
        await count(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?1`, userId),
        table,
      ).toBe(0);
  });

  it('keeps everything when the payment provider can’t end the subscription', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = await newUser();
    const userId = a.power.accountId.slice(2);
    const failing = { ...env, FAKE_PAYMENTS: JSON.stringify({ deleteResult: 'error' }) } as AppEnv;
    await expect(deleteUser(failing, userId)).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringContaining('payment provider'),
    });
    expect(await count('SELECT COUNT(*) AS n FROM auth_users WHERE id = ?1', userId)).toBe(1);
    error.mockRestore();
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
