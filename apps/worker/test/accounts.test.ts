import { DEFAULT_ACCOUNT_ID, type MeResponse, type TreeDetail } from '@tangent/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import { makeChain, makeTree, makeTrunk } from './fixtures.js';

const BASE = 'https://tangent.example.com';

describe('accounts', () => {
  it('migration seeds the built-in default account', async () => {
    const row = await env.DB.prepare('SELECT id, name FROM accounts WHERE id = ?1')
      .bind(DEFAULT_ACCOUNT_ID)
      .first<{ id: string; name: string }>();
    expect(row).toEqual({ id: DEFAULT_ACCOUNT_ID, name: 'Default account' });
  });

  it('/api/me reports the account and new rows are stamped with it', async () => {
    const me = (await (await exports.default.fetch(`${BASE}/api/me`)).json()) as MeResponse;
    expect(me.accountId).toBe(DEFAULT_ACCOUNT_ID);

    const res = await exports.default.fetch(
      new Request(`${BASE}/api/trees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Owned' }),
      }),
    );
    const detail = (await res.json()) as TreeDetail;
    expect(detail.tree.accountId).toBe(DEFAULT_ACCOUNT_ID);
    const row = await env.DB.prepare('SELECT account_id FROM trees WHERE id = ?1')
      .bind(detail.tree.id)
      .first<{ account_id: string }>();
    expect(row?.account_id).toBe(DEFAULT_ACCOUNT_ID);
  });

  it('trees owned by another account are invisible and 404', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO trees (id, account_id, title, trunk_branch_id, created_at, updated_at)
         VALUES ('foreign-tree', 'someone-else', 'Not yours', 'foreign-trunk', 'x', 'x')`,
      ),
    ]);
    const list = (await (await exports.default.fetch(`${BASE}/api/trees`)).json()) as { id: string }[];
    expect(list.some((t) => t.id === 'foreign-tree')).toBe(false);
    expect((await exports.default.fetch(`${BASE}/api/trees/foreign-tree`)).status).toBe(404);
  });

  it("branches and nodes in another account's tree are 404 on every route", async () => {
    const tree = makeTree({ accountId: 'someone-else' });
    const trunk = makeTrunk(tree);
    const repos = createD1Repositories(env.DB);
    await repos.trees.createTree(tree, trunk);
    const nodes = makeChain(trunk, 2, null);
    const reply = nodes[1];
    await repos.trees.appendNodes(nodes, tree.updatedAt);
    const json = (method: string, body: unknown) => ({
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const calls: [string, RequestInit][] = [
      [`/api/branches/${trunk.id}`, json('PATCH', { title: 'Mine now' })],
      [`/api/branches/${trunk.id}`, { method: 'DELETE' }],
      [`/api/branches/${trunk.id}/context`, {}],
      [`/api/branches/${trunk.id}/messages`, json('POST', { content: 'hi' })],
      ['/api/branches', json('POST', { fromNodeId: reply!.id, contextMode: 'path' })],
      [`/api/nodes/${reply!.id}/stream`, {}],
      [`/api/nodes/${reply!.id}/cancel`, { method: 'POST' }],
      [`/api/nodes/${reply!.id}/review`, json('POST', { providerId: 'fake', model: 'fake-1' })],
    ];
    for (const [path, init] of calls) {
      const res = await exports.default.fetch(new Request(`${BASE}${path}`, init));
      expect(res.status, `${init.method ?? 'GET'} ${path}`).toBe(404);
    }
    expect((await repos.trees.getBranch(trunk.id))?.title).toBe(trunk.title);
  });
});
