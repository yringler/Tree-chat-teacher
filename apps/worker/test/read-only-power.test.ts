// Read-only power without a membership (docs/DECISIONS.md "Read-only power
// without a membership"): with the annual fee on, a user without a membership
// (lapsed, cancelled or never paid) keeps reading, exporting and managing
// their power conversations; only generating on their own keys is refused
// (402 `membership_required`). `/api/me` says which fundings need the
// membership, so the apps show those branches read-only, and
// `POST /api/trees/:id/copy-to-learn` copies a power tree into the same user's
// Learn account without a membership, a model call or any credit.
import {
  DEFAULT_SYSTEM_PROMPT,
  type ApiError,
  type Branch,
  type CopyToLearnResponse,
  type MeResponse,
  type TreeBackup,
  type TreeDetail,
  type TreeSummary,
} from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { getBalance } from '../src/billing/ledger.js';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AppEnv } from '../src/env.js';
import { makeNode } from './fixtures.js';
import { insertSubscription } from './mocks/billing-helpers.js';
import { authEnv, client } from './session-client.js';

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

/** The fee on, sold by the fake payment provider (vitest.config.ts). */
const FEE_ON: Partial<AppEnv> = { ANNUAL_FEE_ENABLED: 'true', POOL_ENABLED: 'false' };

let seq = 0;
async function newUser(overrides: Partial<AppEnv> = FEE_ON) {
  const c = client(authEnv(overrides));
  await c.signIn(`read-only${++seq}-${Math.random().toString(36).slice(2, 8)}@example.org`);
  const me = await json<MeResponse>(await c.call('/api/me'));
  return { ...c, me, userId: me.userId! };
}
type User = Awaited<ReturnType<typeof newUser>>;

/**
 * A power tree with one exchange: the trunk on the test provider `fake` (the
 * user's own key, with a custom prompt), and (`credit`, where it is sold) a
 * `summary` branch on Tangent credit off the reply.
 */
async function powerTree(u: User, credit = true): Promise<TreeDetail> {
  const detail = await json<TreeDetail>(
    await u.call('/api/trees', {
      method: 'POST',
      json: { title: 'Primes', providerId: 'fake', model: 'fake-1', systemPrompt: 'Be terse.' },
    }),
    201,
  );
  const trunk = detail.branches[0]!;
  const user = makeNode(trunk, 0, null, { role: 'user', content: 'What is a prime?' });
  const reply = makeNode(trunk, 1, user.id, {
    role: 'assistant',
    content: 'A number with exactly two divisors.',
    providerId: 'fake',
    model: 'fake-1',
  });
  await createD1Repositories(env.DB).trees.appendNodes([user, reply], new Date().toISOString());
  if (credit)
    await json<Branch>(
      await u.call('/api/branches', {
        method: 'POST',
        json: {
          fromNodeId: reply.id,
          providerId: 'openrouter',
          funding: 'credit',
          model: 'smart',
          contextMode: 'summary',
          title: 'On credit',
        },
      }),
      201,
    );
  return json<TreeDetail>(await u.call(`/api/trees/${detail.tree.id}`));
}

/** Everything about a tree that copying must not change (the list's order aside). */
async function snapshot(u: User, treeId: string) {
  const detail = await json<TreeDetail>(await u.call(`/api/trees/${treeId}`));
  const { exportedAt: _at, ...backup } = await json<TreeBackup>(
    await u.call(`/api/trees/${treeId}/backup`),
  );
  return { detail, backup };
}

async function usageCount(accountId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE account_id = ?')
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const copy = (u: User, treeId: string, init: Parameters<User['call']>[1] = {}) =>
  u.call(`/api/trees/${treeId}/copy-to-learn`, { method: 'POST', ...init });

describe('a power user without a membership (the fee on)', () => {
  for (const who of ['lapsed member', 'never-member'] as const) {
    it(`a ${who}: /api/me says own keys need the membership; reads, exports and management stay open`, async () => {
      const u = await newUser();
      if (who === 'lapsed member') await insertSubscription(env, u.userId, 'canceled');
      const me = await json<MeResponse>(await u.call('/api/me'));
      expect(me.membership).toMatchObject({
        required: true,
        status: 'inactive',
        subscriptionStatus: who === 'lapsed member' ? 'canceled' : null,
      });
      expect(me.membershipNeededFor).toEqual(['own-key']);
      // Learn needs none, member or not.
      const learn = await json<MeResponse>(await u.call('/api/me', { learn: 'own-key' }));
      expect(learn.membershipNeededFor).toEqual([]);

      const tree = await powerTree(u);
      const trunk = tree.branches.find((b) => b.parentBranchId === null)!;
      const reply = tree.nodes.find((n) => n.role === 'assistant')!;

      const list = await json<TreeSummary[]>(await u.call('/api/trees'));
      expect(list.map((t) => t.id)).toContain(tree.tree.id);
      expect(
        (await json<TreeDetail>(await u.call(`/api/trees/${tree.tree.id}`))).nodes,
      ).toHaveLength(2);
      expect((await u.call(`/api/branches/${trunk.id}/context`)).status).toBe(200);
      const backup = await u.call(`/api/trees/${tree.tree.id}/backup`);
      expect(backup.status).toBe(200);
      expect(await backup.text()).toContain('A number with exactly two divisors.');
      const md = await u.call(`/api/export?treeId=${tree.tree.id}&scope=tree&format=md`);
      expect(md.status).toBe(200);
      expect(await md.text()).toContain('What is a prime?');
      const renamed = await u.call(`/api/trees/${tree.tree.id}`, {
        method: 'PATCH',
        json: { title: 'Prime numbers' },
      });
      expect(renamed.status).toBe(200);
      const side = tree.branches.find((b) => b.title === 'On credit')!;
      expect(
        (
          await u.call(`/api/branches/${side.id}`, {
            method: 'PATCH',
            json: { title: 'Credit side' },
          })
        ).status,
      ).toBe(200);

      // Generating on the user's own key: the membership, from the server.
      const send = await u.call(`/api/branches/${trunk.id}/messages`, {
        method: 'POST',
        json: { content: 'And 1?' },
      });
      expect((await json<ApiError>(send, 402)).error.code).toBe('membership_required');
      const review = await u.call(`/api/nodes/${reply.id}/review`, {
        method: 'POST',
        json: { providerId: 'fake', model: 'fake-1' },
      });
      expect((await json<ApiError>(review, 402)).error.code).toBe('membership_required');
      const resolve = await u.call(`/api/branches/${trunk.id}/context?resolve=true`);
      expect((await json<ApiError>(resolve, 402)).error.code).toBe('membership_required');

      // Deleting stays open too.
      expect((await u.call(`/api/trees/${tree.tree.id}`, { method: 'DELETE' })).status).toBe(204);
    });
  }

  it('a member: the same fundings need the membership, which they hold', async () => {
    const u = await newUser();
    await insertSubscription(env, u.userId, 'active');
    const me = await json<MeResponse>(await u.call('/api/me'));
    expect(me.membership).toMatchObject({ required: true, status: 'active' });
    expect(me.membershipNeededFor).toEqual(['own-key']);
  });
});

describe('servers that require no membership are never read-only', () => {
  for (const [label, overrides] of [
    ['the fee off', { ANNUAL_FEE_ENABLED: 'false' }],
    // Self-hosted without billing: Polar picked but not configured, so nothing sells the membership.
    ['no billing (self-hosted)', { ANNUAL_FEE_ENABLED: 'true', PAYMENT_PROVIDER: 'polar' }],
  ] as const) {
    it(`${label}: nothing needs the membership, and own keys generate`, async () => {
      const u = await newUser({ ...overrides, POOL_ENABLED: 'false' });
      await insertSubscription(env, u.userId, 'canceled');
      const me = await json<MeResponse>(await u.call('/api/me'));
      expect(me.membership.required).toBe(false);
      expect(me.membershipNeededFor).toEqual([]);
      const tree = await powerTree(u, label === 'the fee off');
      const send = await u.call(`/api/branches/${tree.tree.trunkBranchId}/messages`, {
        method: 'POST',
        json: { content: 'And 1?' },
      });
      expect(send.status, await send.text()).toBe(200);
    });
  }
});

describe('POST /api/trees/:id/copy-to-learn', () => {
  it("copies a power tree into the user's Learn account, adapted, without a membership or credit", async () => {
    const u = await newUser();
    await insertSubscription(env, u.userId, 'canceled');
    const learnId = `u_${u.userId}`;
    const tree = await powerTree(u);
    // The user never opened Learn: its account row doesn't exist yet.
    const accountRow = () =>
      env.DB.prepare('SELECT mode, user_id FROM accounts WHERE id = ?')
        .bind(learnId)
        .first<{ mode: string; user_id: string }>();
    expect(await accountRow()).toBeNull();
    const before = await snapshot(u, tree.tree.id);
    const balanceBefore = await getBalance(env.DB, learnId);
    expect(balanceBefore.balanceMicros).toBe(0);

    const res = await json<CopyToLearnResponse>(await copy(u, tree.tree.id), 201);
    expect(res.title).toBe('Primes');
    expect(res.treeId).not.toBe(tree.tree.id);
    expect(await accountRow()).toEqual({ mode: 'simple', user_id: u.userId });

    // The lesson, in Learn: adapted like any import into Learn.
    const lesson = await json<TreeDetail>(
      await u.call(`/api/trees/${res.treeId}`, { learn: 'own-key' }),
    );
    expect(lesson.tree.accountId).toBe(learnId);
    expect(lesson.tree.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(
      lesson.branches.map((b) => [b.title, b.providerId, b.model, b.contextMode, b.funding]),
    ).toEqual([
      ['Main thread', 'openrouter', 'smart', 'path', 'own-key'],
      ['On credit', 'openrouter', 'smart', 'path', 'own-key'],
    ]);
    expect(lesson.nodes.map((n) => [n.role, n.content])).toEqual([
      ['user', 'What is a prime?'],
      ['assistant', 'A number with exactly two divisors.'],
    ]);
    const lessons = await json<TreeSummary[]>(await u.call('/api/trees', { learn: 'own-key' }));
    expect(lessons.map((t) => t.id)).toEqual([res.treeId]);
    // Not in the power account.
    expect((await u.call(`/api/trees/${res.treeId}`)).status).toBe(404);

    // The power tree is untouched, nothing was spent and no model was called.
    expect(await snapshot(u, tree.tree.id)).toEqual(before);
    const power = await json<TreeSummary[]>(await u.call('/api/trees'));
    expect(power.map((t) => t.id)).toEqual([tree.tree.id]);
    expect(await getBalance(env.DB, learnId)).toEqual(balanceBefore);
    expect(await usageCount(learnId)).toBe(0);

    // A second copy is another lesson.
    const again = await json<CopyToLearnResponse>(await copy(u, tree.tree.id), 201);
    expect(again.treeId).not.toBe(res.treeId);
  });

  it("only the caller's own power trees: another user's, a Learn lesson and unknown ids are 404", async () => {
    const owner = await newUser();
    const other = await newUser();
    const tree = await powerTree(owner);
    const stranger = await copy(other, tree.tree.id);
    expect((await json<ApiError>(stranger, 404)).error.code).toBe('not_found');
    expect(await json<TreeSummary[]>(await other.call('/api/trees', { learn: 'own-key' }))).toEqual(
      [],
    );
    expect((await json<ApiError>(await copy(owner, 'nope'), 404)).error.code).toBe('not_found');

    // A lesson isn't a power tree: from power it's unknown, and Learn can't send the request.
    const { treeId } = await json<CopyToLearnResponse>(await copy(owner, tree.tree.id), 201);
    expect((await copy(owner, treeId)).status).toBe(404);
    const fromLearn = await copy(owner, tree.tree.id, { learn: 'own-key' });
    expect((await json<ApiError>(fromLearn, 400)).error.code).toBe('bad_request');
  });

  it('needs a session, and refuses cross-site requests', async () => {
    const u = await newUser();
    const tree = await powerTree(u);
    const anonymous = client(authEnv(FEE_ON));
    const res = await anonymous.call(`/api/trees/${tree.tree.id}/copy-to-learn`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    const crossSite = await copy(u, tree.tree.id, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect((await json<ApiError>(crossSite, 403)).error.code).toBe('forbidden');
  });
});

describe('a lapsed member on Tangent credit with nothing left', () => {
  it('a send on a credit branch is 402 payment_required, not membership_required; own keys stay locked', async () => {
    const u = await newUser();
    await insertSubscription(env, u.userId, 'canceled');
    const tree = await powerTree(u);
    const side = tree.branches.find((b) => b.funding === 'credit')!;
    expect(await getBalance(env.DB, `u_${u.userId}`)).toMatchObject({
      balanceMicros: 0,
      heldMicros: 0,
    });

    const me = await json<MeResponse>(await u.call('/api/me'));
    expect(me.membership.status).toBe('inactive');
    // Credit never needs the membership, so the branch isn't read-only.
    expect(me.membershipNeededFor).toEqual(['own-key']);

    const send = await u.call(`/api/branches/${side.id}/messages`, {
      method: 'POST',
      json: { content: 'More?' },
    });
    expect((await json<ApiError>(send, 402)).error.code).toBe('payment_required');
    // Nothing was appended, nothing held.
    const after = await json<TreeDetail>(await u.call(`/api/trees/${tree.tree.id}`));
    expect(after.nodes.filter((n) => n.branchId === side.id)).toEqual([]);
    expect(await usageCount(`u_${u.userId}`)).toBe(0);
    // The own-key trunk still answers with the membership.
    const own = await u.call(`/api/branches/${tree.tree.trunkBranchId}/messages`, {
      method: 'POST',
      json: { content: 'And here?' },
    });
    expect((await json<ApiError>(own, 402)).error.code).toBe('membership_required');
  });
});

describe('copying the same power tree to Learn twice', () => {
  it('makes two separate lessons, and leaves the power tree as it was', async () => {
    const u = await newUser();
    await insertSubscription(env, u.userId, 'canceled');
    const tree = await powerTree(u);
    const before = await snapshot(u, tree.tree.id);

    const first = await json<CopyToLearnResponse>(await copy(u, tree.tree.id), 201);
    const second = await json<CopyToLearnResponse>(await copy(u, tree.tree.id), 201);
    expect(second.treeId).not.toBe(first.treeId);
    expect([first.title, second.title]).toEqual(['Primes', 'Primes']);

    const lessons = await json<TreeSummary[]>(await u.call('/api/trees', { learn: 'own-key' }));
    expect(lessons.map((t) => t.id).sort()).toEqual([first.treeId, second.treeId].sort());
    const lesson = async (id: string) =>
      json<TreeDetail>(await u.call(`/api/trees/${id}`, { learn: 'own-key' }));
    const a = await lesson(first.treeId);
    const b = await lesson(second.treeId);
    // Separate rows: no branch or node id is shared.
    const ids = (d: TreeDetail) => [...d.branches.map((x) => x.id), ...d.nodes.map((x) => x.id)];
    expect(ids(a).filter((id) => ids(b).includes(id))).toEqual([]);
    expect(ids(a).filter((id) => ids(before.detail).includes(id))).toEqual([]);
    // The same lesson twice.
    const shape = (d: TreeDetail) => ({
      prompt: d.tree.systemPrompt,
      branches: d.branches.map((x) => [x.title, x.providerId, x.model, x.contextMode, x.funding]),
      nodes: d.nodes.map((x) => [x.role, x.content]),
    });
    expect(shape(b)).toEqual(shape(a));

    // Changing one lesson leaves the other (and the power tree) alone.
    await json(
      await u.call(`/api/trees/${first.treeId}`, {
        method: 'PATCH',
        json: { title: 'Renamed copy' },
        learn: 'own-key',
      }),
    );
    expect(
      (await json<TreeDetail>(await u.call(`/api/trees/${second.treeId}`, { learn: 'own-key' })))
        .tree.title,
    ).toBe('Primes');
    expect(await snapshot(u, tree.tree.id)).toEqual(before);
    expect((await json<TreeSummary[]>(await u.call('/api/trees'))).map((t) => t.id)).toEqual([
      tree.tree.id,
    ]);
  });
});

describe('a new power user with no keys and no credit', () => {
  /** The default providers (PROVIDERS unset: `fake` isn't among them), the fee off. */
  const DEFAULTS: Partial<AppEnv> = {
    PROVIDERS: '',
    ANNUAL_FEE_ENABLED: 'false',
    POOL_ENABLED: 'false',
  };

  it('a new tree starts on the first configured provider (Anthropic); the first send is 401 key_required', async () => {
    // No credit offered (payments not configured), so nothing can pay but the user's own key.
    const u = await newUser({ ...DEFAULTS, PAYMENT_PROVIDER: 'polar' });
    expect(u.me.builtInCredit).toBe(false);
    const providers = await json<{ id: string; available: boolean; funding?: string }[]>(
      await u.call('/api/providers'),
    );
    expect(providers.map((p) => [p.id, p.available, p.funding])).toEqual([
      ['anthropic', false, 'own-key'],
      ['openai', false, 'own-key'],
      ['openrouter', false, 'own-key'],
    ]);

    const tree = await json<TreeDetail>(
      await u.call('/api/trees', { method: 'POST', json: {} }),
      201,
    );
    expect(tree.branches[0]).toMatchObject({
      providerId: 'anthropic',
      model: 'claude-opus-5-5',
      funding: 'own-key',
    });
    const send = await u.call(`/api/branches/${tree.tree.trunkBranchId}/messages`, {
      method: 'POST',
      json: { content: 'Hello' },
    });
    expect((await json<ApiError>(send, 401)).error).toEqual({
      code: 'key_required',
      message: 'Add your Anthropic API key to continue this conversation.',
    });
    // Not a lost session: the user is still signed in.
    expect((await u.call('/api/me')).status).toBe(200);
  });

  it('where Tangent credit is offered, a new tree starts on it instead, and an empty balance is 402', async () => {
    // The built-in endpoint as deployed: not a test fake (the default route skips fakes), on
    // the mock upstream of vitest.config.ts. The send is refused before any call reaches it.
    const u = await newUser({
      ...DEFAULTS,
      SIMPLE_PROVIDER: JSON.stringify({
        id: 'openrouter',
        kind: 'anthropic',
        label: 'Tangent',
        baseUrl: 'https://llm.test',
        apiKeySecret: 'OPENROUTER_SIMPLE_API_KEY',
        defaultModel: 'smart',
        models: [
          { id: 'smart', label: 'Smart' },
          { id: 'simple', label: 'Simple' },
        ],
      }),
      OPENROUTER_SIMPLE_API_KEY: 'sk-ant-goodOPERATOR',
    });
    expect(u.me.builtInCredit).toBe(true);
    const tree = await json<TreeDetail>(
      await u.call('/api/trees', { method: 'POST', json: {} }),
      201,
    );
    // "The first usable non-fake own provider, then Tangent credit": no key, so credit.
    expect(tree.branches[0]).toMatchObject({ providerId: 'openrouter', funding: 'credit' });
    const send = await u.call(`/api/branches/${tree.tree.trunkBranchId}/messages`, {
      method: 'POST',
      json: { content: 'Hello' },
    });
    expect((await json<ApiError>(send, 402)).error.code).toBe('payment_required');
  });
});
