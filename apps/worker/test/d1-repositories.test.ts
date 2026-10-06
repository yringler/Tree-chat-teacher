import { ConflictError } from '@tangent/core';
import { DEFAULT_ACCOUNT_ID, type Branch, type ChatNode, type Tree } from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createD1Repositories, SNAPSHOT_CHUNK_CHARS } from '../src/db/d1-repositories.js';
import {
  makeBranch,
  makeChain,
  makeNode,
  makeShare,
  makeTree,
  makeTrunk,
  uid,
} from './fixtures.js';

const repos = createD1Repositories(env.DB);

async function count(table: string, column: string, value: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${column} = ?1`)
    .bind(value)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

async function seedTree(overrides: Partial<Tree> = {}): Promise<{ tree: Tree; trunk: Branch }> {
  const tree = makeTree(overrides);
  const trunk = makeTrunk(tree);
  await repos.trees.createTree(tree, trunk);
  return { tree, trunk };
}

/**
 * trunk:  t0 - t1 - t2 - t3
 * b1 (from t1):   a0 - a1
 * b2 (from a0):        c0 - c1
 */
async function seedMultiBranch() {
  const { tree, trunk } = await seedTree();
  const t = makeChain(trunk, 4, null);
  await repos.trees.appendNodes(t, '2026-01-01T00:01:00.000Z');
  const b1 = makeBranch(tree, {
    parentBranchId: trunk.id,
    branchPointNodeId: t[1]!.id,
    title: 'B1',
  });
  await repos.trees.createBranch(b1);
  const a = makeChain(b1, 2, t[1]!.id);
  await repos.trees.appendNodes(a, '2026-01-01T00:02:00.000Z');
  const b2 = makeBranch(tree, { parentBranchId: b1.id, branchPointNodeId: a[0]!.id, title: 'B2' });
  await repos.trees.createBranch(b2);
  const c = makeChain(b2, 2, a[0]!.id);
  await repos.trees.appendNodes(c, '2026-01-01T00:03:00.000Z');
  return { tree, trunk, b1, b2, t, a, c };
}

describe('trees', () => {
  it('createTree / getTree round-trip including nullable system prompt', async () => {
    const { tree, trunk } = await seedTree({ systemPrompt: 'Be terse.' });
    expect(await repos.trees.getTree(tree.id)).toEqual(tree);
    expect(await repos.trees.getBranch(trunk.id)).toEqual(trunk);

    const { tree: t2 } = await seedTree({ systemPrompt: null });
    expect((await repos.trees.getTree(t2.id))?.systemPrompt).toBeNull();
    expect(await repos.trees.getTree('missing')).toBeNull();
  });

  it('createTree is atomic: a failing trunk insert leaves no tree', async () => {
    const { trunk } = await seedTree();
    const tree = makeTree();
    // Reusing an existing branch id makes the second statement fail.
    await expect(repos.trees.createTree(tree, { ...trunk, treeId: tree.id })).rejects.toThrow();
    expect(await repos.trees.getTree(tree.id)).toBeNull();
  });

  it('updateTree applies partial patches and returns null for unknown ids', async () => {
    const { tree } = await seedTree({ systemPrompt: 'x' });
    const updated = await repos.trees.updateTree(tree.id, {
      title: 'Renamed',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(updated).toEqual({ ...tree, title: 'Renamed', updatedAt: '2026-02-01T00:00:00.000Z' });
    const cleared = await repos.trees.updateTree(tree.id, { systemPrompt: null });
    expect(cleared?.systemPrompt).toBeNull();
    expect(await repos.trees.updateTree(tree.id, {})).toEqual(cleared);
    expect(await repos.trees.updateTree('missing', { title: 'x' })).toBeNull();
  });

  it('listTrees returns counts ordered by updatedAt desc', async () => {
    const multi = await seedMultiBranch();
    const { tree: older } = await seedTree({ updatedAt: '2025-01-01T00:00:00.000Z' });
    await repos.trees.updateTree(multi.tree.id, { updatedAt: '2030-01-01T00:00:00.000Z' });
    const list = await repos.trees.listTrees(DEFAULT_ACCOUNT_ID);
    const ids = list.map((t) => t.id);
    expect(ids.indexOf(multi.tree.id)).toBeLessThan(ids.indexOf(older.id));
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]!.updatedAt >= list[i]!.updatedAt).toBe(true);
    }
    const summary = list.find((t) => t.id === multi.tree.id);
    expect(summary).toEqual({
      id: multi.tree.id,
      title: multi.tree.title,
      createdAt: multi.tree.createdAt,
      updatedAt: '2030-01-01T00:00:00.000Z',
      branchCount: 3,
      messageCount: 8,
    });
    expect(list.find((t) => t.id === older.id)).toMatchObject({ branchCount: 1, messageCount: 0 });
  });

  it('deleteTree cascades to branches, nodes, summaries, shares and snapshots', async () => {
    const { tree, t } = await seedMultiBranch();
    await repos.summaries.putSummary({
      anchorNodeId: t[1]!.id,
      sourceHash: 'h',
      providerId: 'fake',
      model: 'm',
      content: 's',
      treeId: tree.id,
      createdAt: 'x',
    });
    const share = makeShare(tree);
    await repos.shares.createShare(share, '{"v":1}');
    expect(await count('share_snapshots', 'share_id', share.id)).toBe(1);

    expect(await repos.trees.deleteTree(tree.id)).toBe(true);
    expect(await repos.trees.getTree(tree.id)).toBeNull();
    expect(await count('branches', 'tree_id', tree.id)).toBe(0);
    expect(await count('nodes', 'tree_id', tree.id)).toBe(0);
    expect(await count('summaries', 'tree_id', tree.id)).toBe(0);
    expect(await count('shares', 'tree_id', tree.id)).toBe(0);
    expect(await count('share_snapshots', 'share_id', share.id)).toBe(0);
    expect(await repos.trees.deleteTree(tree.id)).toBe(false);
  });
});

describe('branches', () => {
  it('createBranch / getBranch / listBranches round-trip booleans and nullables', async () => {
    const { tree, trunk } = await seedTree();
    const [n0] = makeChain(trunk, 1, null);
    await repos.trees.appendNodes([n0!], 'x');
    const b = makeBranch(tree, {
      parentBranchId: trunk.id,
      branchPointNodeId: n0!.id,
      contextMode: 'summary',
      anchorQuote: 'quoted text',
      isPrivate: true,
      titleSource: 'user',
      createdAt: '2026-01-01T00:00:05.000Z',
    });
    await repos.trees.createBranch(b);
    expect(await repos.trees.getBranch(b.id)).toEqual(b);
    expect(await repos.trees.listBranches(tree.id)).toEqual([trunk, b]);
    expect(await repos.trees.getBranch('missing')).toBeNull();
  });

  it('updateBranch patches fields including isPrivate and anchorQuote=null', async () => {
    const { tree, trunk } = await seedTree();
    const b = makeBranch(tree, { parentBranchId: trunk.id, anchorQuote: 'q', isPrivate: true });
    await repos.trees.createBranch(b);
    const updated = await repos.trees.updateBranch(b.id, {
      isPrivate: false,
      anchorQuote: null,
      contextMode: 'independent',
      title: 'New',
      titleSource: 'auto',
      providerId: 'anthropic',
      model: 'claude-opus-5-5',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });
    expect(updated).toEqual({
      ...b,
      isPrivate: false,
      anchorQuote: null,
      contextMode: 'independent',
      title: 'New',
      titleSource: 'auto',
      providerId: 'anthropic',
      model: 'claude-opus-5-5',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });
    expect(await repos.trees.updateBranch(b.id, {})).toEqual(updated);
    expect(await repos.trees.updateBranch('missing', { title: 'x' })).toBeNull();
  });

  it('deleteBranches removes the branches with their nodes, summaries and targeted shares', async () => {
    const { tree, trunk, b1, b2, t, a, c } = await seedMultiBranch();
    const summary = {
      sourceHash: 'h',
      providerId: 'fake',
      model: 'm',
      content: 's',
      treeId: tree.id,
      createdAt: 'x',
    };
    await repos.summaries.putSummary({ ...summary, anchorNodeId: a[1]!.id });
    await repos.summaries.putSummary({ ...summary, anchorNodeId: t[1]!.id });
    const doomed = makeShare(tree, { scope: 'path', targetNodeId: c[1]!.id });
    const kept = makeShare(tree, { scope: 'path', targetNodeId: t[3]!.id });
    const whole = makeShare(tree);
    await repos.shares.createShare(doomed, '{"v":1}');
    await repos.shares.createShare(kept, null);
    await repos.shares.createShare(whole, null);

    await repos.trees.deleteBranches(tree.id, [b1.id, b2.id], '2026-04-01T00:00:00.000Z');

    expect(await repos.trees.listBranches(tree.id)).toEqual([trunk]);
    expect((await repos.trees.listNodes(tree.id)).map((n) => n.id).sort()).toEqual(
      t.map((n) => n.id).sort(),
    );
    expect(await repos.summaries.getSummary(a[1]!.id, 'h', 'm')).toBeNull();
    expect(await repos.summaries.getSummary(t[1]!.id, 'h', 'm')).not.toBeNull();
    expect(await repos.shares.getShare(doomed.id)).toBeNull();
    expect(await count('share_snapshots', 'share_id', doomed.id)).toBe(0);
    expect(await repos.shares.getShare(kept.id)).not.toBeNull();
    expect(await repos.shares.getShare(whole.id)).not.toBeNull();
    expect((await repos.trees.getTree(tree.id))?.updatedAt).toBe('2026-04-01T00:00:00.000Z');
  });

  it('deleteBranches only touches the given tree', async () => {
    const { tree, b1 } = await seedMultiBranch();
    const other = await seedMultiBranch();
    await repos.trees.deleteBranches(other.tree.id, [b1.id], 'x');
    expect(await repos.trees.getBranch(b1.id)).toEqual(b1);
    expect(await count('nodes', 'branch_id', b1.id)).toBe(2);
    expect((await repos.trees.getTree(tree.id))?.updatedAt).not.toBe('x');
  });

  it('getBranchChain returns trunk → branch', async () => {
    const { trunk, b1, b2 } = await seedMultiBranch();
    expect((await repos.trees.getBranchChain(b2.id)).map((b) => b.id)).toEqual([
      trunk.id,
      b1.id,
      b2.id,
    ]);
    expect(await repos.trees.getBranchChain(trunk.id)).toEqual([trunk]);
    const chain = await repos.trees.getBranchChain(b1.id);
    expect(chain[1]).toEqual(b1);
    expect(await repos.trees.getBranchChain('missing')).toEqual([]);
  });
});

describe('nodes', () => {
  it('round-trips usage, nullables and roles', async () => {
    const { trunk } = await seedTree();
    const user = makeNode(trunk, 0, null, { role: 'user', content: 'hi' });
    const asst = makeNode(trunk, 1, user.id, {
      role: 'assistant',
      providerId: 'anthropic',
      model: 'claude-opus-5-5',
      usage: { inputTokens: 12, outputTokens: 34 },
      status: 'error',
      error: 'boom',
    });
    await repos.trees.appendNodes([user, asst], 'x');
    expect(await repos.trees.getNode(user.id)).toEqual(user);
    expect(await repos.trees.getNode(asst.id)).toEqual(asst);
    expect(await repos.trees.getNode('missing')).toBeNull();
  });

  it('appendNodes bumps the tree updatedAt', async () => {
    const { tree, trunk } = await seedTree();
    await repos.trees.appendNodes(makeChain(trunk, 2, null), '2026-05-05T00:00:00.000Z');
    expect((await repos.trees.getTree(tree.id))?.updatedAt).toBe('2026-05-05T00:00:00.000Z');
  });

  it('listNodes and listBranchNodes', async () => {
    const { tree, trunk, b1, t, a, c } = await seedMultiBranch();
    expect((await repos.trees.listBranchNodes(trunk.id)).map((n) => n.id)).toEqual(
      t.map((n) => n.id),
    );
    expect(await repos.trees.listBranchNodes(b1.id)).toEqual(a);
    const all = await repos.trees.listNodes(tree.id);
    expect(all).toHaveLength(8);
    expect(new Set(all.map((n) => n.id))).toEqual(new Set([...t, ...a, ...c].map((n) => n.id)));
  });

  it('getAncestorPath follows parent ids across branches, root first', async () => {
    const { t, a, c } = await seedMultiBranch();
    const path = await repos.trees.getAncestorPath(c[1]!.id);
    expect(path.map((n) => n.id)).toEqual([t[0]!.id, t[1]!.id, a[0]!.id, c[0]!.id, c[1]!.id]);
    expect(path[4]).toEqual(c[1]);
    expect((await repos.trees.getAncestorPath(t[3]!.id)).map((n) => n.id)).toEqual(
      t.map((n) => n.id),
    );
    expect((await repos.trees.getAncestorPath(a[1]!.id)).map((n) => n.id)).toEqual([
      t[0]!.id,
      t[1]!.id,
      a[0]!.id,
      a[1]!.id,
    ]);
    expect(await repos.trees.getAncestorPath('missing')).toEqual([]);
  });

  it('appendNodes is atomic and maps (branch_id, seq) conflicts to ConflictError', async () => {
    const { tree, trunk } = await seedTree();
    const [n0] = makeChain(trunk, 1, null);
    await repos.trees.appendNodes([n0!], '2026-01-01T00:00:10.000Z');

    const ok = makeNode(trunk, 1, n0!.id);
    const dup = makeNode(trunk, 0, ok.id); // seq 0 already taken
    const err = await repos.trees
      .appendNodes([ok, dup], '2026-09-09T00:00:00.000Z')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).code).toBe('conflict');
    // Nothing from the failed batch was applied.
    expect(await repos.trees.getNode(ok.id)).toBeNull();
    expect(await repos.trees.getNode(dup.id)).toBeNull();
    expect((await repos.trees.getTree(tree.id))?.updatedAt).toBe('2026-01-01T00:00:10.000Z');
  });

  it('appendNodes with many nodes splits inserts under the parameter limit', async () => {
    const { trunk } = await seedTree();
    const chain = makeChain(trunk, 23, null);
    await repos.trees.appendNodes(chain, 'x');
    expect(await repos.trees.listBranchNodes(trunk.id)).toEqual(chain);
  });

  it('non-unique failures are not reported as conflicts', async () => {
    const { tree } = await seedTree();
    // Unknown branch: FK violation, not a UNIQUE violation.
    const orphan = makeNode(makeBranch(tree, { id: uid('nobranch') }), 0, null);
    const err = await repos.trees.appendNodes([orphan], 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConflictError);
  });

  it('updateNode patches content/status/error/usage', async () => {
    const { trunk } = await seedTree();
    const n = makeNode(trunk, 0, null, { status: 'streaming', content: '' });
    await repos.trees.appendNodes([n], 'x');
    await repos.trees.updateNode(n.id, { content: 'partial' });
    expect((await repos.trees.getNode(n.id))?.content).toBe('partial');
    await repos.trees.updateNode(n.id, {
      status: 'complete',
      content: 'final',
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    expect(await repos.trees.getNode(n.id)).toEqual({
      ...n,
      status: 'complete',
      content: 'final',
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    await repos.trees.updateNode(n.id, { status: 'error', error: 'interrupted', usage: null });
    expect(await repos.trees.getNode(n.id)).toMatchObject({
      status: 'error',
      error: 'interrupted',
      usage: null,
    });
    await repos.trees.updateNode(n.id, { error: null });
    expect((await repos.trees.getNode(n.id))?.error).toBeNull();
    await repos.trees.updateNode(n.id, {}); // no-op
  });

  it('listStreamingNodes returns only streaming nodes of the tree', async () => {
    const { tree, trunk } = await seedTree();
    const u = makeNode(trunk, 0, null);
    const s = makeNode(trunk, 1, u.id, { status: 'streaming' });
    await repos.trees.appendNodes([u, s], 'x');
    const other = await seedTree();
    await repos.trees.appendNodes([makeNode(other.trunk, 0, null, { status: 'streaming' })], 'x');
    expect(await repos.trees.listStreamingNodes(tree.id)).toEqual([s]);
    await repos.trees.updateNode(s.id, { status: 'complete' });
    expect(await repos.trees.listStreamingNodes(tree.id)).toEqual([]);
  });

  it('importTree inserts 50 nodes and several branches atomically', async () => {
    const tree = makeTree({ title: 'Imported', systemPrompt: 'sys' });
    const trunk = makeTrunk(tree);
    const trunkNodes = makeChain(trunk, 30, null);
    const branchesList: Branch[] = [trunk];
    const nodesList: ChatNode[] = [...trunkNodes];
    for (let i = 0; i < 10; i++) {
      const b = makeBranch(tree, {
        parentBranchId: trunk.id,
        branchPointNodeId: trunkNodes[i]!.id,
        isPrivate: i % 2 === 0,
        anchorQuote: i % 3 === 0 ? `q${i}` : null,
      });
      branchesList.push(b);
      nodesList.push(...makeChain(b, 2, trunkNodes[i]!.id));
    }
    expect(nodesList).toHaveLength(50);
    await repos.trees.importTree(tree, branchesList, nodesList);
    expect(await repos.trees.getTree(tree.id)).toEqual(tree);
    expect(await repos.trees.listBranches(tree.id)).toHaveLength(11);
    const stored = await repos.trees.listNodes(tree.id);
    expect(stored).toHaveLength(50);
    const byId = new Map(stored.map((n) => [n.id, n]));
    for (const n of nodesList) expect(byId.get(n.id)).toEqual(n);
    for (const b of branchesList) expect(await repos.trees.getBranch(b.id)).toEqual(b);
  });

  it('importTree rolls back entirely on failure', async () => {
    const tree = makeTree();
    const trunk = makeTrunk(tree);
    const nodesList = makeChain(trunk, 20, null);
    nodesList.push(makeNode(trunk, 3, null)); // duplicate seq in the last statement
    await expect(repos.trees.importTree(tree, [trunk], nodesList)).rejects.toThrow();
    expect(await repos.trees.getTree(tree.id)).toBeNull();
    expect(await count('nodes', 'tree_id', tree.id)).toBe(0);
    expect(await count('branches', 'tree_id', tree.id)).toBe(0);
  });
});

describe('summaries', () => {
  it('get/put round-trip and upsert on the (anchor, hash, model) key', async () => {
    const { tree, trunk } = await seedTree();
    const [n] = makeChain(trunk, 1, null);
    await repos.trees.appendNodes([n!], 'x');
    const rec = {
      anchorNodeId: n!.id,
      sourceHash: 'abc',
      providerId: 'fake',
      model: 'm1',
      content: 'first',
      treeId: tree.id,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(await repos.summaries.getSummary(n!.id, 'abc', 'm1')).toBeNull();
    await repos.summaries.putSummary(rec);
    expect(await repos.summaries.getSummary(n!.id, 'abc', 'm1')).toEqual(rec);

    const replaced = {
      ...rec,
      content: 'second',
      providerId: 'anthropic',
      createdAt: '2026-02-01T00:00:00.000Z',
    };
    await repos.summaries.putSummary(replaced);
    expect(await repos.summaries.getSummary(n!.id, 'abc', 'm1')).toEqual(replaced);

    await repos.summaries.putSummary({ ...rec, model: 'm2', content: 'other model' });
    expect((await repos.summaries.getSummary(n!.id, 'abc', 'm2'))?.content).toBe('other model');
    expect((await repos.summaries.getSummary(n!.id, 'abc', 'm1'))?.content).toBe('second');
    expect(await repos.summaries.getSummary(n!.id, 'other-hash', 'm1')).toBeNull();
  });
});

describe('shares', () => {
  it('create / get / getByToken / list with tree title and booleans', async () => {
    const { tree, trunk } = await seedTree({ title: 'Shared tree' });
    const [n] = makeChain(trunk, 1, null);
    await repos.trees.appendNodes([n!], 'x');
    const share = makeShare(tree, {
      scope: 'subtree',
      targetNodeId: n!.id,
      includeAncestors: true,
      mode: 'live',
      title: 'Look',
      expiresAt: '2027-01-01T00:00:00.000Z',
      publishedAt: null,
    });
    await repos.shares.createShare(share, null);
    const expected = { ...share, treeTitle: 'Shared tree' };
    expect(await repos.shares.getShare(share.id)).toEqual(expected);
    expect(await repos.shares.getShareByToken(share.token)).toEqual(expected);
    expect(await repos.shares.getSnapshot(share.id)).toBeNull();
    expect(
      (await repos.shares.listShares(DEFAULT_ACCOUNT_ID)).find((s) => s.id === share.id),
    ).toEqual(expected);
    expect(await repos.shares.getShare('missing')).toBeNull();
    expect(await repos.shares.getShareByToken('missing')).toBeNull();
  });

  it('rejects duplicate tokens atomically (no orphan snapshot)', async () => {
    const { tree } = await seedTree();
    const a = makeShare(tree);
    await repos.shares.createShare(a, '{}');
    const b = makeShare(tree, { token: a.token });
    await expect(repos.shares.createShare(b, '{"b":1}')).rejects.toThrow();
    expect(await repos.shares.getShare(b.id)).toBeNull();
    expect(await count('share_snapshots', 'share_id', b.id)).toBe(0);
  });

  it('updateShare patches fields and replaces / deletes / keeps the snapshot', async () => {
    const { tree } = await seedTree({ title: 'T' });
    const share = makeShare(tree);
    await repos.shares.createShare(share, '{"v":1,"n":1}');
    expect(await repos.shares.getSnapshot(share.id)).toBe('{"v":1,"n":1}');

    // Patch without snapshot argument keeps the snapshot.
    const renamed = await repos.shares.updateShare(share.id, {
      title: 'New title',
      expiresAt: null,
    });
    expect(renamed).toEqual({ ...share, title: 'New title', treeTitle: 'T' });
    expect(await repos.shares.getSnapshot(share.id)).toBe('{"v":1,"n":1}');

    // Republish: replace snapshot + bump version.
    const big = 'y'.repeat(SNAPSHOT_CHUNK_CHARS + 10);
    const republished = await repos.shares.updateShare(
      share.id,
      {
        version: 2,
        publishedAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
      big,
    );
    expect(republished).toMatchObject({ version: 2, publishedAt: '2026-04-01T00:00:00.000Z' });
    expect(await repos.shares.getSnapshot(share.id)).toBe(big);
    expect(await count('share_snapshots', 'share_id', share.id)).toBe(2);

    // Shrinking replaces all chunks (no stale tail chunk).
    await repos.shares.updateShare(share.id, {}, '{"small":true}');
    expect(await repos.shares.getSnapshot(share.id)).toBe('{"small":true}');
    expect(await count('share_snapshots', 'share_id', share.id)).toBe(1);

    // Revoke + delete snapshot.
    const revoked = await repos.shares.updateShare(
      share.id,
      { revokedAt: '2026-05-01T00:00:00.000Z' },
      null,
    );
    expect(revoked?.revokedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(await repos.shares.getSnapshot(share.id)).toBeNull();

    expect(await repos.shares.updateShare('missing', { title: 'x' }, '{}')).toBeNull();
    expect(await count('share_snapshots', 'share_id', 'missing')).toBe(0);
  });

  it('snapshots over 600K chars round-trip across 3 chunks', async () => {
    const { tree } = await seedTree();
    const share = makeShare(tree);
    // Multi-byte characters and JSON punctuation to catch any chunk-boundary bugs.
    const unit = '{"k":"héllo wörld ✓ \\"quoted\\" 😀"},';
    let json = '[';
    while (json.length < 610_000) json += unit;
    json += '0]';
    expect(json.length).toBeGreaterThan(600_000);
    await repos.shares.createShare(share, json);
    expect(await count('share_snapshots', 'share_id', share.id)).toBe(3);
    const back = await repos.shares.getSnapshot(share.id);
    expect(back?.length).toBe(json.length);
    expect(back === json).toBe(true);
    expect(() => JSON.parse(back!) as unknown).not.toThrow();
  });

  it('incrementViewCount is additive', async () => {
    const { tree } = await seedTree();
    const share = makeShare(tree);
    await repos.shares.createShare(share, '{}');
    await Promise.all([
      repos.shares.incrementViewCount(share.id),
      repos.shares.incrementViewCount(share.id),
      repos.shares.incrementViewCount(share.id),
    ]);
    expect((await repos.shares.getShare(share.id))?.viewCount).toBe(3);
    await repos.shares.incrementViewCount('missing'); // no-op
  });
});

describe('account settings', () => {
  it('has none until the first save, then upserts per account', async () => {
    const a = uid('acct');
    const b = uid('acct');
    expect(await repos.settings.getSettings(a)).toBeNull();
    await repos.settings.putSettings(a, { systemPrompt: 'First' }, '2026-01-01T00:00:00.000Z');
    expect(await repos.settings.getSettings(a)).toEqual({ systemPrompt: 'First' });
    const long = 'x'.repeat(20_000);
    await repos.settings.putSettings(a, { systemPrompt: long }, '2026-01-02T00:00:00.000Z');
    expect(await repos.settings.getSettings(a)).toEqual({ systemPrompt: long });
    await repos.settings.putSettings(a, { systemPrompt: null }, '2026-01-03T00:00:00.000Z');
    expect(await repos.settings.getSettings(a)).toEqual({ systemPrompt: null });
    expect(await count('account_settings', 'account_id', a)).toBe(1);
    expect(await repos.settings.getSettings(b)).toBeNull();
  });
});

describe('grounding columns', () => {
  const sources = [{ url: 'https://example.org/a', title: 'A', excerpt: null }];

  it('round-trips node sources (null, [] and a list) through insert, update and the ancestor path', async () => {
    const { trunk } = await seedTree();
    const n = makeNode(trunk, 0, null, { sources: [] });
    await repos.trees.appendNodes([n], 'x');
    expect((await repos.trees.getNode(n.id))?.sources).toEqual([]);
    await repos.trees.updateNode(n.id, { sources });
    expect((await repos.trees.getNode(n.id))?.sources).toEqual(sources);
    expect((await repos.trees.getAncestorPath(n.id))[0]?.sources).toEqual(sources);
    await repos.trees.updateNode(n.id, { sources: null });
    expect((await repos.trees.getNode(n.id))?.sources).toBeNull();
  });

  it('reads malformed stored sources as null', async () => {
    const { trunk } = await seedTree();
    const n = makeNode(trunk, 0, null);
    await repos.trees.appendNodes([n], 'x');
    await env.DB.prepare('UPDATE nodes SET sources = ?1 WHERE id = ?2')
      .bind('{not json', n.id)
      .run();
    expect((await repos.trees.getNode(n.id))?.sources).toBeNull();
  });

  it('stores, patches and returns the branch grounding setting (also via the chain CTE)', async () => {
    const { tree, trunk } = await seedTree();
    const b = makeBranch(tree, { parentBranchId: trunk.id, grounding: 'off' });
    await repos.trees.createBranch(b);
    expect((await repos.trees.getBranch(b.id))?.grounding).toBe('off');
    expect((await repos.trees.updateBranch(b.id, { grounding: 'always' }))?.grounding).toBe(
      'always',
    );
    expect((await repos.trees.getBranchChain(b.id)).map((x) => x.grounding)).toEqual([
      'auto',
      'always',
    ]);
  });
});
