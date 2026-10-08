import {
  DEFAULT_SYSTEM_PROMPT,
  type Branch,
  type MeResponse,
  type StreamEvent,
  type TreeBackup,
  type TreeDetail,
  type TreeSummary,
} from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { grantCredit } from '../src/billing/ledger.js';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AppEnv } from '../src/env.js';
import { makeNode } from './fixtures.js';
import { authEnv, client } from './session-client.js';

/*
 * Import and export in Learn (docs/DECISIONS.md "Import and export in
 * Learn"): the same backup format as power, imported into the account of the
 * app that sends it, and adapted to what Learn can run when that is Learn.
 */

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

let seq = 0;
async function newUser(e: AppEnv = authEnv({ POOL_ENABLED: 'false' })) {
  const c = client(e);
  await c.signIn(`learn-import${++seq}-${Math.random().toString(36).slice(2, 8)}@example.org`);
  const power = await json<MeResponse>(await c.call('/api/me'));
  const learn = await json<MeResponse>(await c.call('/api/me', { learn: 'own-key' }));
  return { ...c, power, learn };
}
type User = Awaited<ReturnType<typeof newUser>>;

/**
 * A power tree: the trunk on the BYOK provider `ant` with a custom prompt and
 * one exchange, a `summary` branch on Tangent credit with Learn's Normal model,
 * and an `independent` branch on the test provider `fake`.
 */
async function powerTree(u: User): Promise<TreeDetail> {
  const detail = await json<TreeDetail>(
    await u.call('/api/trees', {
      method: 'POST',
      json: { title: 'Primes', providerId: 'ant', systemPrompt: 'Talk like a pirate.' },
    }),
    201,
  );
  const trunk = detail.branches[0]!;
  const user = makeNode(trunk, 0, null, { role: 'user', content: 'What is a prime?' });
  const reply = makeNode(trunk, 1, user.id, {
    role: 'assistant',
    content: 'A number with exactly two divisors.',
    providerId: 'ant',
    model: 'claude-test',
  });
  await createD1Repositories(env.DB).trees.appendNodes([user, reply], new Date().toISOString());
  for (const req of [
    {
      providerId: 'openrouter',
      funding: 'credit',
      model: 'simple',
      contextMode: 'summary',
      title: 'On credit',
    },
    {
      providerId: 'fake',
      contextMode: 'independent',
      anchorQuote: 'two divisors',
      title: 'Independent',
    },
  ]) {
    await json<Branch>(
      await u.call('/api/branches', { method: 'POST', json: { fromNodeId: reply.id, ...req } }),
      201,
    );
  }
  return json<TreeDetail>(await u.call(`/api/trees/${detail.tree.id}`));
}

const routes = (d: Pick<TreeDetail, 'branches'>) =>
  d.branches.map((b) => [b.title, b.providerId, b.model, b.contextMode, b.funding]);

function parseSse(text: string): StreamEvent[] {
  return text
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as StreamEvent);
}

describe('importing into Learn', () => {
  it("adapts a power backup to Learn's provider, models, path context and prompt, in the Learn account", async () => {
    const u = await newUser();
    const original = await powerTree(u);
    const backup = await json<TreeBackup>(await u.call(`/api/trees/${original.tree.id}/backup`));

    const lesson = await json<TreeDetail>(
      await u.call('/api/import', { method: 'POST', json: backup, learn: 'own-key' }),
      201,
    );
    expect(lesson.tree.accountId).toBe(u.learn.accountId);
    expect(lesson.tree.accountId).toBe(`u_${u.power.accountId.slice(2)}`);
    expect(lesson.tree.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(routes(lesson)).toEqual([
      ['Main thread', 'openrouter', 'smart', 'path', 'own-key'],
      ['On credit', 'openrouter', 'simple', 'path', 'own-key'],
      ['Independent', 'openrouter', 'smart', 'path', 'own-key'],
    ]);
    expect(lesson.nodes.map((n) => [n.content, n.providerId])).toEqual([
      ['What is a prime?', null],
      ['A number with exactly two divisors.', 'ant'],
    ]);

    // Stored that way, in the Learn account only.
    const stored = await json<TreeDetail>(
      await u.call(`/api/trees/${lesson.tree.id}`, { learn: 'own-key' }),
    );
    expect(routes(stored)).toEqual(routes(lesson));
    const learnList = await json<TreeSummary[]>(await u.call('/api/trees', { learn: 'credit' }));
    expect(learnList.map((t) => t.id)).toEqual([lesson.tree.id]);
    expect((await u.call(`/api/trees/${lesson.tree.id}`)).status).toBe(404);
    const row = await env.DB.prepare('SELECT account_id FROM trees WHERE id = ?1')
      .bind(lesson.tree.id)
      .first<{ account_id: string }>();
    expect(row?.account_id).toBe(u.learn.accountId);
  });

  it('the imported lesson continues on Learn (here on credit), never on the power providers', async () => {
    const u = await newUser();
    const original = await powerTree(u);
    const backup = await json<TreeBackup>(await u.call(`/api/trees/${original.tree.id}/backup`));
    const lesson = await json<TreeDetail>(
      await u.call('/api/import', { method: 'POST', json: backup, learn: 'credit' }),
      201,
    );
    await grantCredit(env.DB, {
      accountId: u.learn.accountId,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
      note: 'test',
    });
    const side = lesson.branches.find((b) => b.title === 'Independent')!;
    const res = await u.call(`/api/branches/${side.id}/messages`, {
      method: 'POST',
      json: { content: 'Why exactly two?' },
      learn: 'credit',
    });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      node: { providerId: 'openrouter', model: 'smart' },
    });
  });

  it('power imports are unchanged: providers, models, context, funding and prompt kept, in the power account', async () => {
    const u = await newUser();
    const original = await powerTree(u);
    const backup = await json<TreeBackup>(await u.call(`/api/trees/${original.tree.id}/backup`));
    const copy = await json<TreeDetail>(
      await u.call('/api/import', { method: 'POST', json: backup }),
      201,
    );
    expect(copy.tree.accountId).toBe(u.power.accountId);
    expect(copy.tree.systemPrompt).toBe('Talk like a pirate.');
    expect(routes(copy)).toEqual(routes(original));
    expect(routes(copy)).toEqual([
      ['Main thread', 'ant', 'claude-test', 'path', 'own-key'],
      ['On credit', 'openrouter', 'simple', 'summary', 'credit'],
      ['Independent', 'fake', 'fake-1', 'independent', 'own-key'],
    ]);
  });

  it('round-trips: a Learn export imports into Learn and power alike', async () => {
    const u = await newUser();
    const created = await json<TreeDetail>(
      await u.call('/api/trees', {
        method: 'POST',
        json: { title: 'Light', model: 'simple' },
        learn: 'own-key',
      }),
      201,
    );
    const trunk = created.branches[0]!;
    const user = makeNode(trunk, 0, null, { role: 'user', content: 'What is light?' });
    const reply = makeNode(trunk, 1, user.id, {
      role: 'assistant',
      content: 'A wave and a particle.',
      providerId: 'openrouter',
      model: 'simple',
    });
    await createD1Repositories(env.DB).trees.appendNodes([user, reply], new Date().toISOString());
    await json<Branch>(
      await u.call('/api/branches', {
        method: 'POST',
        json: { fromNodeId: reply.id, contextMode: 'path', anchorQuote: 'a particle' },
        learn: 'own-key',
      }),
      201,
    );
    const original = await json<TreeDetail>(
      await u.call(`/api/trees/${created.tree.id}`, { learn: 'own-key' }),
    );

    const res = await u.call(`/api/trees/${created.tree.id}/backup`, { learn: 'own-key' });
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="light.tangent.json"',
    );
    const backup = await json<TreeBackup>(res);
    expect(backup.format).toBe('tangent-tree-backup');
    // The power app can't download it: it is the Learn account's tree.
    expect((await u.call(`/api/trees/${created.tree.id}/backup`)).status).toBe(404);

    const shape = (d: TreeDetail) => ({
      title: d.tree.title,
      prompt: d.tree.systemPrompt,
      routes: routes(d),
      anchors: d.branches.map((b) => b.anchorQuote),
      nodes: d.nodes.map((n) => [n.role, n.content, n.providerId, n.model]),
    });
    const again = await json<TreeDetail>(
      await u.call('/api/import', { method: 'POST', json: backup, learn: 'own-key' }),
      201,
    );
    expect(again.tree.id).not.toBe(original.tree.id);
    expect(shape(again)).toEqual(shape(original));

    const inPower = await json<TreeDetail>(
      await u.call('/api/import', { method: 'POST', json: backup }),
      201,
    );
    expect(inPower.tree.accountId).toBe(u.power.accountId);
    expect(shape(inPower)).toEqual(shape(original));
  });

  it('rejects what is not a backup, in either app', async () => {
    const u = await newUser();
    for (const learn of ['own-key', undefined] as const) {
      const res = await u.call('/api/import', {
        method: 'POST',
        json: { format: 'something-else', version: 1 },
        ...(learn ? { learn } : {}),
      });
      expect(res.status).toBe(400);
    }
  });
});

/**
 * A backup made before the fake reply provider was retired and before funding
 * was split from the provider: no `funding` fields, a trunk on `fake` and a side
 * branch on the legacy built-in id `tangent`.
 */
function oldBackup(): TreeBackup {
  const at = '2026-09-15T10:00:00.000Z';
  const branch = (over: Partial<TreeBackup['branches'][number]>) => ({
    id: 'old_trunk',
    treeId: 'old_tree',
    parentBranchId: null,
    branchPointNodeId: null,
    contextMode: 'path' as const,
    anchorQuote: null,
    title: 'Main thread',
    titleSource: 'default' as const,
    isPrivate: false,
    providerId: 'fake',
    model: 'fake-1',
    createdAt: at,
    updatedAt: at,
    ...over,
  });
  const node = (over: Partial<TreeBackup['nodes'][number]>) => ({
    id: 'old_n1',
    treeId: 'old_tree',
    branchId: 'old_trunk',
    parentId: null,
    seq: 0,
    role: 'user' as const,
    content: 'Hello?',
    status: 'complete' as const,
    error: null,
    providerId: null,
    model: null,
    usage: null,
    createdAt: at,
    ...over,
  });
  return {
    format: 'tangent-tree-backup',
    version: 1,
    exportedAt: at,
    tree: {
      id: 'old_tree',
      title: 'From the fake days',
      systemPrompt: 'Be brief.',
      trunkBranchId: 'old_trunk',
      createdAt: at,
      updatedAt: at,
    },
    branches: [
      branch({}),
      branch({
        id: 'old_side',
        parentBranchId: 'old_trunk',
        branchPointNodeId: 'old_n2',
        title: 'On the built-in provider',
        providerId: 'tangent',
        model: 'smart',
        contextMode: 'summary',
      }),
    ],
    nodes: [
      node({}),
      node({
        id: 'old_n2',
        parentId: 'old_n1',
        seq: 1,
        role: 'assistant',
        content: 'Fake reply (fake-1) to 1 message(s)',
        providerId: 'fake',
        model: 'fake-1',
      }),
    ],
  } as TreeBackup;
}

describe('an old backup that names the retired `fake` provider', () => {
  /** A deployment with the default power providers: `fake` isn't one (vitest.config.ts adds it). */
  const defaults = authEnv({ POOL_ENABLED: 'false', PROVIDERS: '' });

  it('imports into power as it is, and a send on the fake branch is "Unknown provider"', async () => {
    const u = await newUser(defaults);
    const copy = await json<TreeDetail>(
      await u.call('/api/import', { method: 'POST', json: oldBackup() }),
      201,
    );
    expect(copy.tree.accountId).toBe(u.power.accountId);
    expect(copy.tree.systemPrompt).toBe('Be brief.');
    // `fake` is kept, like any provider the server doesn't offer; `tangent` is the
    // endpoint `openrouter`, and a missing funding is the user's own key.
    expect(routes(copy)).toEqual([
      ['Main thread', 'fake', 'fake-1', 'path', 'own-key'],
      ['On the built-in provider', 'openrouter', 'smart', 'summary', 'own-key'],
    ]);
    expect(copy.nodes.map((n) => n.providerId)).toEqual([null, 'fake']);
    const providers = await json<{ id: string }[]>(await u.call('/api/providers'));
    expect(providers.map((p) => p.id)).not.toContain('fake');

    const res = await u.call(`/api/branches/${copy.tree.trunkBranchId}/messages`, {
      method: 'POST',
      json: { content: 'Still there?' },
    });
    const body = await json<{ error: { code: string; message: string } }>(res, 400);
    expect(body.error).toEqual({ code: 'bad_request', message: 'Unknown provider "fake"' });
    // Nothing was appended.
    const after = await json<TreeDetail>(await u.call(`/api/trees/${copy.tree.id}`));
    expect(after.nodes).toHaveLength(2);

    // Branch settings fix it: picking a provider the server offers.
    const moved = await json<Branch>(
      await u.call(`/api/branches/${copy.tree.trunkBranchId}`, {
        method: 'PATCH',
        json: { providerId: 'anthropic' },
      }),
    );
    expect(moved).toMatchObject({ providerId: 'anthropic', funding: 'own-key' });
  });

  it("imported into Learn, it is adapted onto Learn's provider like any other backup", async () => {
    const u = await newUser(defaults);
    const lesson = await json<TreeDetail>(
      await u.call('/api/import', { method: 'POST', json: oldBackup(), learn: 'own-key' }),
      201,
    );
    expect(lesson.tree.accountId).toBe(u.learn.accountId);
    expect(lesson.tree.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(routes(lesson)).toEqual([
      ['Main thread', 'openrouter', 'smart', 'path', 'own-key'],
      ['On the built-in provider', 'openrouter', 'smart', 'path', 'own-key'],
    ]);
    // The reply keeps the provider it ran on: history.
    expect(lesson.nodes.map((n) => n.providerId)).toEqual([null, 'fake']);

    // And it continues there (here on credit, the fake built-in provider of the tests).
    await grantCredit(env.DB, {
      accountId: u.learn.accountId,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
      note: 'test',
    });
    const res = await u.call(`/api/branches/${lesson.tree.trunkBranchId}/messages`, {
      method: 'POST',
      json: { content: 'Still there?' },
      learn: 'credit',
    });
    expect(res.status).toBe(200);
    expect(parseSse(await res.text()).at(-1)).toMatchObject({
      type: 'done',
      node: { providerId: 'openrouter', model: 'smart' },
    });
  });
});
