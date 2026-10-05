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
 * one exchange, a `summary` branch on Tangent credit with Learn's Simple model,
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
