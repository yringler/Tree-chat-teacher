// Links between two messages of a tree (`/api/links`) as the dev bypass in
// power mode; other users' links are covered in multi-user.test.ts and
// read-only power in read-only-power.test.ts.
import type {
  ApiError,
  Branch,
  ChatNode,
  DeleteBranchResponse,
  NodeLink,
  TreeBackup,
  TreeDetail,
} from '@tangent/shared';
import { MAX_LINK_NOTE_CHARS } from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import { makeChain } from './fixtures.js';
import { call, ok } from './http.js';

const link = (fromNodeId: string, toNodeId: string, note?: string | null) =>
  call('/api/links', {
    method: 'POST',
    json: { fromNodeId, toNodeId, ...(note !== undefined ? { note } : {}) },
  });

/** A tree with two messages on the trunk and a branch off the second with two of its own. */
async function linkedTree() {
  const detail = await ok<TreeDetail>(
    call('/api/trees', { method: 'POST', json: { title: 'Links', providerId: 'fake' } }),
    201,
  );
  const repos = createD1Repositories(env.DB);
  const trunk = detail.branches[0]!;
  const t = makeChain(trunk, 2, null);
  await repos.trees.appendNodes(t, new Date().toISOString());
  const branch = await ok<Branch>(
    call('/api/branches', { method: 'POST', json: { fromNodeId: t[1]!.id, title: 'Side' } }),
    201,
  );
  const b = makeChain(branch, 2, t[1]!.id);
  await repos.trees.appendNodes(b, new Date().toISOString());
  return { treeId: detail.tree.id, trunk, branch, t, b };
}

describe('/api/links', () => {
  it('creates a link (201), answers the same pair either way with it (200), and lists it with the tree', async () => {
    const { treeId, t, b } = await linkedTree();
    const before = await ok<TreeDetail>(call(`/api/trees/${treeId}`));
    expect(before.links).toEqual([]);

    const created = await ok<NodeLink>(link(t[0]!.id, b[1]!.id, '  same idea '), 201);
    expect(created).toMatchObject({
      treeId,
      sourceNodeId: t[0]!.id,
      targetNodeId: b[1]!.id,
      note: 'same idea',
      origin: 'user',
    });
    expect(await ok<NodeLink>(link(b[1]!.id, t[0]!.id), 200)).toEqual(created);
    expect(await ok<NodeLink>(link(t[0]!.id, b[1]!.id, 'other'), 200)).toEqual(created);

    const after = await ok<TreeDetail>(call(`/api/trees/${treeId}`));
    expect(after.links).toEqual([created]);
    expect(after.tree.updatedAt >= before.tree.updatedAt).toBe(true);
  });

  it('400s a self-link, two trees, a long note and a malformed body; 404s an unknown message', async () => {
    const { t } = await linkedTree();
    const elsewhere = await linkedTree();
    const code = async (res: Promise<Response>, status: number) =>
      (await ok<ApiError>(res, status)).error.code;
    expect(await code(link(t[0]!.id, t[0]!.id), 400)).toBe('bad_request');
    expect(await code(link(t[0]!.id, elsewhere.t[0]!.id), 400)).toBe('bad_request');
    expect(await code(link(t[0]!.id, t[1]!.id, 'x'.repeat(MAX_LINK_NOTE_CHARS + 1)), 400)).toBe(
      'bad_request',
    );
    expect(
      await code(call('/api/links', { method: 'POST', json: { fromNodeId: t[0]!.id } }), 400),
    ).toBe('bad_request');
    expect(await code(link(t[0]!.id, 'missing'), 404)).toBe('not_found');
    expect(await code(link('missing', t[0]!.id), 404)).toBe('not_found');
  });

  it('edits the note (blank = none) and deletes the link (204, then 404)', async () => {
    const { treeId, t, b } = await linkedTree();
    const created = await ok<NodeLink>(link(t[1]!.id, b[0]!.id), 201);
    const noted = await ok<NodeLink>(
      call(`/api/links/${created.id}`, { method: 'PATCH', json: { note: ' because ' } }),
    );
    expect(noted).toMatchObject({ id: created.id, note: 'because' });
    const cleared = await ok<NodeLink>(
      call(`/api/links/${created.id}`, { method: 'PATCH', json: { note: '   ' } }),
    );
    expect(cleared.note).toBeNull();
    expect((await call(`/api/links/${created.id}`, { method: 'PATCH', json: {} })).status).toBe(
      400,
    );

    expect((await call(`/api/links/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await ok<TreeDetail>(call(`/api/trees/${treeId}`))).links).toEqual([]);
    expect((await call(`/api/links/${created.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(
      (await call(`/api/links/${created.id}`, { method: 'PATCH', json: { note: 'x' } })).status,
    ).toBe(404);
  });

  it('deleting a branch (through its Durable Object) drops the links of its messages only', async () => {
    const { treeId, t, b, branch } = await linkedTree();
    await ok<NodeLink>(link(t[0]!.id, b[1]!.id), 201);
    const kept = await ok<NodeLink>(link(t[0]!.id, t[1]!.id), 201);
    const res = await ok<DeleteBranchResponse>(
      call(`/api/branches/${branch.id}`, { method: 'DELETE' }),
    );
    expect(res.nodeIds.sort()).toEqual(b.map((n) => n.id).sort());
    expect((await ok<TreeDetail>(call(`/api/trees/${treeId}`))).links).toEqual([kept]);
  });

  it('backs links up and restores them on the new messages; exports leave them out', async () => {
    const { treeId, t, b } = await linkedTree();
    const created = await ok<NodeLink>(link(t[0]!.id, b[1]!.id, 'the note'), 201);
    const backup = await ok<TreeBackup>(call(`/api/trees/${treeId}/backup`));
    expect(backup.links).toEqual([created]);

    const restored = await ok<TreeDetail>(
      call('/api/import', { method: 'POST', json: backup }),
      201,
    );
    expect(restored.links).toHaveLength(1);
    const [copy] = restored.links;
    const contentOf = (id: string) => restored.nodes.find((n: ChatNode) => n.id === id)?.content;
    expect(copy).toMatchObject({ treeId: restored.tree.id, note: 'the note' });
    expect([contentOf(copy!.sourceNodeId), contentOf(copy!.targetNodeId)]).toEqual([
      t[0]!.content,
      b[1]!.content,
    ]);
    expect((await ok<TreeDetail>(call(`/api/trees/${restored.tree.id}`))).links).toEqual(
      restored.links,
    );

    const md = await call(`/api/export?treeId=${treeId}&scope=tree&format=md`);
    expect(md.status).toBe(200);
    expect(await md.text()).not.toContain('the note');
  });
});
