import { ConflictError } from '@tangent/core';
import {
  REPLY_CANCELLED_ERROR,
  REPLY_CUT_OFF_ERROR,
  REPLY_EMPTY_ERROR,
  REPLY_THINKING_ONLY_ERROR,
  type Branch,
  type Tree,
} from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
// The contract suite is core's test code, not part of its package.
import { describeRepositories } from '../../../packages/core/test/repository-contract.js';
import { createD1Repositories, SNAPSHOT_CHUNK_CHARS } from '../src/db/d1-repositories.js';
import {
  makeBranch,
  makeChain,
  makeLink,
  makeNode,
  makeShare,
  makeTree,
  makeTrunk,
  uid,
} from './fixtures.js';

const repos = createD1Repositories(env.DB);

describeRepositories('D1', () => repos);

// What only D1 can show: atomic batches, the parameter limit, snapshot chunks,
// constraints and cascades in the schema, and how stored rows read back.

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
  it('createTree is atomic: a failing trunk insert leaves no tree', async () => {
    const { trunk } = await seedTree();
    const tree = makeTree();
    // Reusing an existing branch id makes the second statement fail.
    await expect(repos.trees.createTree(tree, { ...trunk, treeId: tree.id })).rejects.toThrow();
    expect(await repos.trees.getTree(tree.id)).toBeNull();
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
});

describe('nodes', () => {
  it('the recursive reads map every column as the plain reads do', async () => {
    const { tree, trunk } = await seedTree();
    const question = makeNode(trunk, 0, null, { role: 'user', content: 'q' });
    await repos.trees.appendNodes([question], 'x');
    const side = makeBranch(tree, {
      parentBranchId: trunk.id,
      branchPointNodeId: question.id,
      contextMode: 'summary',
      anchorQuote: 'quoted',
      titleSource: 'user',
      isPrivate: true,
      funding: 'credit',
      grounding: 'off',
    });
    await repos.trees.createBranch(side);
    const answer = makeNode(side, 0, question.id, {
      role: 'assistant',
      status: 'error',
      error: 'cut off',
      errorKind: 'cut_off',
      providerId: 'openrouter',
      model: 'm',
      usage: { inputTokens: 3, outputTokens: 4 },
      sources: [{ url: 'https://example.org', title: 'Example', excerpt: null }],
    });
    await repos.trees.appendNodes([answer], 'x');
    expect(await repos.trees.getBranchChain(side.id)).toEqual([trunk, side]);
    expect(await repos.trees.getAncestorPath(answer.id)).toEqual([question, answer]);
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

describe('shares', () => {
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

  it('deleteShare removes the share with its snapshot chunks', async () => {
    const { tree } = await seedTree();
    const share = makeShare(tree);
    const kept = makeShare(tree);
    await repos.shares.createShare(share, 'z'.repeat(SNAPSHOT_CHUNK_CHARS + 10));
    await repos.shares.createShare(kept, '{}');
    expect(await count('share_snapshots', 'share_id', share.id)).toBe(2);

    expect(await repos.shares.deleteShare(share.id)).toBe(true);
    expect(await repos.shares.getShare(share.id)).toBeNull();
    expect(await count('share_snapshots', 'share_id', share.id)).toBe(0);
    expect(await repos.shares.getSnapshot(kept.id)).toBe('{}');
    expect(await repos.shares.deleteShare(share.id)).toBe(false);
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

describe('node error kinds', () => {
  it('backfills the kind of rows written before the column from their copy', async () => {
    const { trunk } = await seedTree();
    const copies = {
      cut_off: REPLY_CUT_OFF_ERROR,
      thinking_only: REPLY_THINKING_ONLY_ERROR,
      empty: REPLY_EMPTY_ERROR,
      cancelled: REPLY_CANCELLED_ERROR,
      interrupted: 'Interrupted before the reply finished',
      provider: 'The provider stream ended unexpectedly',
    };
    const rows = Object.values(copies).map((error, i) =>
      makeNode(trunk, i, null, { status: 'error', error }),
    );
    const other = makeNode(trunk, rows.length, null, { status: 'error', error: 'HTTP 500' });
    const complete = makeNode(trunk, rows.length + 1, null, { error: REPLY_CUT_OFF_ERROR });
    await repos.trees.appendNodes([...rows, other, complete], 'x');
    const migration = env.TEST_MIGRATIONS.find((m) => m.name === '0001_node_error_kind.sql');
    const backfill = migration?.queries.filter((q) => q.trimStart().startsWith('UPDATE')) ?? [];
    expect(backfill).toHaveLength(6);
    for (const q of backfill) await env.DB.prepare(q).run();
    const kinds = await Promise.all(
      [...rows, other, complete].map(async (n) => (await repos.trees.getNode(n.id))?.errorKind),
    );
    expect(kinds).toEqual([...Object.keys(copies), null, null]);
  });
});

describe('links', () => {
  it('the table refuses a second row for a pair and a link to itself', async () => {
    const { t } = await seedMultiBranch();
    await repos.trees.createLink(makeLink(t[0]!, t[1]!), 'x');
    const insert = (l: ReturnType<typeof makeLink>, pair: string) =>
      env.DB.prepare(
        `INSERT INTO node_links (id, tree_id, source_node_id, target_node_id, pair_key, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'x', 'x')`,
      )
        .bind(l.id, l.treeId, l.sourceNodeId, l.targetNodeId, pair)
        .run();
    const reversed = makeLink(t[1]!, t[0]!);
    await expect(insert(reversed, [t[0]!.id, t[1]!.id].sort().join('|'))).rejects.toThrow(/UNIQUE/);
    const self = makeLink(t[2]!, t[2]!);
    await expect(insert(self, `${t[2]!.id}|${t[2]!.id}`)).rejects.toThrow(/CHECK/);
    // Defaults: origin `user`, no note.
    const fresh = makeLink(t[2]!, t[3]!);
    await insert(fresh, [t[2]!.id, t[3]!.id].sort().join('|'));
    expect(await repos.trees.getLink(fresh.id)).toMatchObject({ origin: 'user', note: null });
  });

  it('deleteBranches over many branches stays under the parameter limit', async () => {
    const { tree, trunk } = await seedTree();
    const root = makeNode(trunk, 0, null);
    await repos.trees.appendNodes([root], 'x');
    const many = Array.from({ length: 60 }, () =>
      makeBranch(tree, { parentBranchId: trunk.id, branchPointNodeId: root.id }),
    );
    for (const b of many) await repos.trees.createBranch(b);
    const heads = many.map((b) => makeNode(b, 0, root.id));
    await repos.trees.appendNodes(heads, 'x');
    for (const h of heads.slice(0, 5)) await repos.trees.createLink(makeLink(root, h), 'x');
    await repos.trees.deleteBranches(
      tree.id,
      many.map((b) => b.id),
      'y',
    );
    expect(await repos.trees.listLinks(tree.id)).toEqual([]);
    expect(await count('nodes', 'tree_id', tree.id)).toBe(1);
  });

  it('a link goes with its tree and, by FK cascade, with either message', async () => {
    const { tree, t, a } = await seedMultiBranch();
    const link = makeLink(t[3]!, a[1]!);
    await repos.trees.createLink(link, 'x');
    await env.DB.prepare('DELETE FROM nodes WHERE id = ?1').bind(a[1]!.id).run();
    expect(await repos.trees.getLink(link.id)).toBeNull();

    const other = makeLink(t[0]!, t[1]!);
    await repos.trees.createLink(other, 'x');
    expect(await repos.trees.deleteTree(tree.id)).toBe(true);
    expect(await count('node_links', 'tree_id', tree.id)).toBe(0);
  });

  it('importTree inserts links in chunks under the parameter limit, atomically', async () => {
    const tree = makeTree({ title: 'Linked' });
    const trunk = makeTrunk(tree);
    const nodesList = makeChain(trunk, 30, null);
    const linksList = nodesList
      .slice(1)
      .map((n, i) => makeLink(nodesList[0]!, n, { note: `n${i}` }));
    expect(linksList).toHaveLength(29);
    await repos.trees.importTree(tree, [trunk], nodesList, linksList);
    const stored = await repos.trees.listLinks(tree.id);
    expect(new Set(stored.map((l) => l.id))).toEqual(new Set(linksList.map((l) => l.id)));
    for (const l of linksList) expect(await repos.trees.getLink(l.id)).toEqual(l);

    // A link to a node outside the import fails the whole import.
    const broken = makeTree();
    const brokenTrunk = makeTrunk(broken);
    const brokenNodes = makeChain(brokenTrunk, 2, null);
    await expect(
      repos.trees.importTree(broken, [brokenTrunk], brokenNodes, [
        makeLink(brokenNodes[0]!, brokenNodes[1]!),
        makeLink(brokenNodes[0]!, makeNode(brokenTrunk, 9, null)),
      ]),
    ).rejects.toThrow();
    expect(await repos.trees.getTree(broken.id)).toBeNull();
    expect(await count('node_links', 'tree_id', broken.id)).toBe(0);
  });
});
