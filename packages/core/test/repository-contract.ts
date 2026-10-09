import type { Branch, ChatNode, NodeLink, Share, SummaryRecord, Tree } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../src/errors.js';
import type { Repositories } from '../src/repository.js';

/*
 * The behaviour every implementation of the storage ports shares: the memory
 * repositories (core's tests and the demos) and the Worker's D1 ones run this
 * same suite, so what a test of one proves holds for the other. Each test
 * makes its own ids and accounts, so the suite runs on a shared database.
 */

const counters = new Map<string, number>();
/**
 * Unique per call. Consecutive ids of a kind start with `Z`, `a`, `M`: their
 * byte order (SQLite's) differs from both creation order and locale order,
 * so a tie-break on ids shows which one an implementation uses.
 */
function uid(prefix: string): string {
  const n = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, n);
  const salt = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${'ZaM'[n % 3]}${n}_${salt}`;
}

function makeTree(overrides: Partial<Tree> = {}): Tree {
  const id = overrides.id ?? uid('tree');
  return {
    id,
    accountId: uid('acct'),
    title: 'Tree',
    systemPrompt: null,
    trunkBranchId: overrides.trunkBranchId ?? `${id}_trunk`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeBranch(tree: Tree, overrides: Partial<Branch> = {}): Branch {
  return {
    id: uid('br'),
    treeId: tree.id,
    parentBranchId: null,
    branchPointNodeId: null,
    contextMode: 'path',
    anchorQuote: null,
    title: 'Branch',
    titleSource: 'default',
    isPrivate: false,
    providerId: 'fake',
    model: 'fake-model',
    grounding: 'auto',
    funding: 'own-key',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTrunk(tree: Tree): Branch {
  return makeBranch(tree, { id: tree.trunkBranchId, title: 'Trunk' });
}

function makeNode(
  branch: Branch,
  seq: number,
  parentId: string | null,
  overrides: Partial<ChatNode> = {},
): ChatNode {
  return {
    id: uid('n'),
    treeId: branch.treeId,
    branchId: branch.id,
    parentId,
    seq,
    role: seq % 2 === 0 ? 'user' : 'assistant',
    content: `content ${seq}`,
    status: 'complete',
    error: null,
    errorKind: null,
    providerId: null,
    model: null,
    usage: null,
    sources: null,
    createdAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

/** `count` chained nodes on `branch`, the first hanging off `firstParent`. */
function makeChain(branch: Branch, count: number, firstParent: string | null): ChatNode[] {
  const out: ChatNode[] = [];
  let parent = firstParent;
  for (let i = 0; i < count; i++) {
    const n = makeNode(branch, i, parent);
    out.push(n);
    parent = n.id;
  }
  return out;
}

function makeShare(tree: Tree, overrides: Partial<Share> = {}): Share {
  return {
    id: uid('sh'),
    token: uid('tok'),
    accountId: tree.accountId,
    treeId: tree.id,
    scope: 'tree',
    targetNodeId: null,
    includeAncestors: false,
    mode: 'snapshot',
    title: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    publishedAt: '2026-01-02T00:00:00.000Z',
    version: 1,
    viewCount: 0,
    ...overrides,
  };
}

function makeLink(source: ChatNode, target: ChatNode, overrides: Partial<NodeLink> = {}): NodeLink {
  return {
    id: uid('ln'),
    treeId: source.treeId,
    sourceNodeId: source.id,
    targetNodeId: target.id,
    note: null,
    origin: 'user',
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    ...overrides,
  };
}

function summaryOf(tree: Tree, anchor: ChatNode, overrides: Partial<SummaryRecord> = {}) {
  return {
    anchorNodeId: anchor.id,
    sourceHash: 'h',
    providerId: 'fake',
    model: 'm',
    content: 's',
    treeId: tree.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } satisfies SummaryRecord;
}

/** Byte order, as SQLite compares text. */
const byBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Runs the repository contract against the repositories `factory` returns. */
export function describeRepositories(name: string, factory: () => Repositories): void {
  describe(`${name} repositories`, () => {
    const repos = factory();

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
    async function seedMultiBranch(overrides: Partial<Tree> = {}) {
      const { tree, trunk } = await seedTree(overrides);
      const t = makeChain(trunk, 4, null);
      await repos.trees.appendNodes(t, '2026-01-01T00:01:00.000Z');
      const b1 = makeBranch(tree, {
        parentBranchId: trunk.id,
        branchPointNodeId: t[1]!.id,
        title: 'B1',
        createdAt: '2026-01-01T00:00:02.000Z',
      });
      await repos.trees.createBranch(b1);
      const a = makeChain(b1, 2, t[1]!.id);
      await repos.trees.appendNodes(a, '2026-01-01T00:02:00.000Z');
      const b2 = makeBranch(tree, {
        parentBranchId: b1.id,
        branchPointNodeId: a[0]!.id,
        title: 'B2',
        createdAt: '2026-01-01T00:00:03.000Z',
      });
      await repos.trees.createBranch(b2);
      const c = makeChain(b2, 2, a[0]!.id);
      await repos.trees.appendNodes(c, '2026-01-01T00:03:00.000Z');
      return { tree, trunk, b1, b2, t, a, c };
    }

    describe('trees', () => {
      it('createTree / getTree round-trip, including a null system prompt', async () => {
        const { tree, trunk } = await seedTree({ systemPrompt: 'Be terse.' });
        expect(await repos.trees.getTree(tree.id)).toEqual(tree);
        expect(await repos.trees.getBranch(trunk.id)).toEqual(trunk);
        const { tree: t2 } = await seedTree({ systemPrompt: null });
        expect((await repos.trees.getTree(t2.id))?.systemPrompt).toBeNull();
        expect(await repos.trees.getTree('missing')).toBeNull();
      });

      it('updateTree applies partial patches and returns null for unknown ids', async () => {
        const { tree } = await seedTree({ systemPrompt: 'x' });
        const updated = await repos.trees.updateTree(tree.id, {
          title: 'Renamed',
          updatedAt: '2026-02-01T00:00:00.000Z',
        });
        expect(updated).toEqual({
          ...tree,
          title: 'Renamed',
          updatedAt: '2026-02-01T00:00:00.000Z',
        });
        const cleared = await repos.trees.updateTree(tree.id, { systemPrompt: null });
        expect(cleared?.systemPrompt).toBeNull();
        expect(await repos.trees.updateTree(tree.id, {})).toEqual(cleared);
        expect(await repos.trees.updateTree('missing', { title: 'x' })).toBeNull();
      });

      it("listTrees lists the account's trees with counts, newest first, ties by id", async () => {
        const accountId = uid('acct');
        const multi = await seedMultiBranch({ accountId });
        const older = await seedTree({ accountId, updatedAt: '2025-01-01T00:00:00.000Z' });
        await repos.trees.updateTree(multi.tree.id, { updatedAt: '2030-01-01T00:00:00.000Z' });
        const tied = [
          await seedTree({ accountId, updatedAt: '2027-01-01T00:00:00.000Z' }),
          await seedTree({ accountId, updatedAt: '2027-01-01T00:00:00.000Z' }),
          await seedTree({ accountId, updatedAt: '2027-01-01T00:00:00.000Z' }),
        ];
        await seedTree();
        const list = await repos.trees.listTrees(accountId);
        expect(list.map((t) => t.id)).toEqual([
          multi.tree.id,
          ...tied.map(({ tree }) => tree.id).sort(byBytes),
          older.tree.id,
        ]);
        expect(list[0]).toEqual({
          id: multi.tree.id,
          title: multi.tree.title,
          createdAt: multi.tree.createdAt,
          updatedAt: '2030-01-01T00:00:00.000Z',
          branchCount: 3,
          messageCount: 8,
        });
        expect(list.at(-1)).toMatchObject({ branchCount: 1, messageCount: 0 });
        expect(await repos.trees.listTrees(uid('acct'))).toEqual([]);
      });

      it('deleteTree takes its branches, nodes, links, summaries, shares and snapshots', async () => {
        const { tree, b1, t, a } = await seedMultiBranch();
        await repos.summaries.putSummary(summaryOf(tree, t[1]!));
        const link = makeLink(t[0]!, a[0]!);
        await repos.trees.createLink(link, 'x');
        const share = makeShare(tree);
        await repos.shares.createShare(share, '{"v":1}');

        expect(await repos.trees.deleteTree(tree.id)).toBe(true);
        expect(await repos.trees.getTree(tree.id)).toBeNull();
        expect(await repos.trees.listBranches(tree.id)).toEqual([]);
        expect(await repos.trees.getBranch(b1.id)).toBeNull();
        expect(await repos.trees.listNodes(tree.id)).toEqual([]);
        expect(await repos.trees.getLink(link.id)).toBeNull();
        expect(await repos.summaries.getSummary(t[1]!.id, 'h', 'm')).toBeNull();
        expect(await repos.shares.getShare(share.id)).toBeNull();
        expect(await repos.shares.getSnapshot(share.id)).toBeNull();
        expect(await repos.trees.deleteTree(tree.id)).toBe(false);
      });
    });

    describe('branches', () => {
      it('createBranch / getBranch round-trip; listBranches is oldest first', async () => {
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
          grounding: 'off',
          funding: 'credit',
          createdAt: '2026-01-01T00:00:05.000Z',
        });
        // Created later, but older: the listing goes by createdAt, then id.
        const tied = [0, 1, 2].map(() =>
          makeBranch(tree, { parentBranchId: trunk.id, createdAt: '2026-01-01T00:00:02.000Z' }),
        );
        await repos.trees.createBranch(b);
        for (const x of tied) await repos.trees.createBranch(x);
        expect(await repos.trees.getBranch(b.id)).toEqual(b);
        expect(await repos.trees.listBranches(tree.id)).toEqual([
          trunk,
          ...[...tied].sort((x, y) => byBytes(x.id, y.id)),
          b,
        ]);
        expect(await repos.trees.getBranch('missing')).toBeNull();
      });

      it('updateBranch applies partial patches and returns null for unknown ids', async () => {
        const { tree, trunk } = await seedTree();
        const b = makeBranch(tree, { parentBranchId: trunk.id, anchorQuote: 'q', isPrivate: true });
        await repos.trees.createBranch(b);
        const patch = {
          isPrivate: false,
          anchorQuote: null,
          contextMode: 'independent',
          title: 'New',
          titleSource: 'auto',
          providerId: 'anthropic',
          model: 'claude-opus-5-5',
          grounding: 'always',
          funding: 'credit',
          updatedAt: '2026-03-01T00:00:00.000Z',
        } as const;
        const updated = await repos.trees.updateBranch(b.id, patch);
        expect(updated).toEqual({ ...b, ...patch });
        expect(await repos.trees.updateBranch(b.id, {})).toEqual(updated);
        expect(await repos.trees.updateBranch('missing', { title: 'x' })).toBeNull();
      });

      it('getBranchChain returns trunk → branch, empty for an unknown branch', async () => {
        const { trunk, b1, b2 } = await seedMultiBranch();
        expect(await repos.trees.getBranchChain(b2.id)).toEqual([trunk, b1, b2]);
        expect(await repos.trees.getBranchChain(trunk.id)).toEqual([trunk]);
        expect(await repos.trees.getBranchChain('missing')).toEqual([]);
      });

      it('deleteBranches takes their nodes, links, summaries and targeted shares, and bumps the tree', async () => {
        const { tree, trunk, b1, b2, t, a, c } = await seedMultiBranch();
        await repos.summaries.putSummary(summaryOf(tree, a[1]!));
        await repos.summaries.putSummary(summaryOf(tree, t[1]!));
        const doomed = makeShare(tree, { scope: 'path', targetNodeId: c[1]!.id });
        const kept = makeShare(tree, { scope: 'path', targetNodeId: t[3]!.id });
        const whole = makeShare(tree);
        await repos.shares.createShare(doomed, '{"v":1}');
        await repos.shares.createShare(kept, null);
        await repos.shares.createShare(whole, null);
        const fromTrunk = makeLink(t[3]!, c[1]!);
        const intoTrunk = makeLink(a[0]!, t[0]!, { createdAt: '2026-01-03T00:00:01.000Z' });
        const keptLink = makeLink(t[0]!, t[3]!, { createdAt: '2026-01-03T00:00:02.000Z' });
        for (const l of [fromTrunk, intoTrunk, keptLink]) await repos.trees.createLink(l, 'x');

        await repos.trees.deleteBranches(tree.id, [b1.id, b2.id], '2026-04-01T00:00:00.000Z');

        expect(await repos.trees.listBranches(tree.id)).toEqual([trunk]);
        expect(await repos.trees.listNodes(tree.id)).toEqual(t);
        expect(await repos.trees.listLinks(tree.id)).toEqual([keptLink]);
        expect(await repos.summaries.getSummary(a[1]!.id, 'h', 'm')).toBeNull();
        expect(await repos.summaries.getSummary(t[1]!.id, 'h', 'm')).not.toBeNull();
        expect(await repos.shares.getShare(doomed.id)).toBeNull();
        expect(await repos.shares.getSnapshot(doomed.id)).toBeNull();
        expect(await repos.shares.getShare(kept.id)).not.toBeNull();
        expect(await repos.shares.getShare(whole.id)).not.toBeNull();
        expect((await repos.trees.getTree(tree.id))?.updatedAt).toBe('2026-04-01T00:00:00.000Z');
      });

      it('deleteBranches only touches the given tree', async () => {
        const { tree, b1, a } = await seedMultiBranch();
        const other = await seedMultiBranch();
        await repos.trees.deleteBranches(other.tree.id, [b1.id], 'x');
        expect(await repos.trees.getBranch(b1.id)).toEqual(b1);
        expect(await repos.trees.listBranchNodes(b1.id)).toEqual(a);
        expect((await repos.trees.getTree(tree.id))?.updatedAt).not.toBe('x');
      });
    });

    describe('nodes', () => {
      it('round-trips usage, sources, error kinds, nullables and roles', async () => {
        const { trunk } = await seedTree();
        const user = makeNode(trunk, 0, null, { role: 'user', content: 'hi', sources: [] });
        const asst = makeNode(trunk, 1, user.id, {
          role: 'assistant',
          providerId: 'anthropic',
          model: 'claude-opus-5-5',
          usage: { inputTokens: 12, outputTokens: 34 },
          status: 'error',
          error: 'boom',
          errorKind: 'provider',
          sources: [{ url: 'https://example.org/a', title: 'A', excerpt: null }],
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

      it('listBranchNodes goes by seq; listNodes by branch id, then seq', async () => {
        const { tree, trunk, b1, b2, t, a, c } = await seedMultiBranch();
        expect(await repos.trees.listBranchNodes(trunk.id)).toEqual(t);
        expect(await repos.trees.listBranchNodes(b1.id)).toEqual(a);
        const byBranch = [
          [trunk, t],
          [b1, a],
          [b2, c],
        ] as const;
        const expected = [...byBranch]
          .sort(([x], [y]) => byBytes(x.id, y.id))
          .flatMap(([, nodes]) => nodes);
        expect(await repos.trees.listNodes(tree.id)).toEqual(expected);
        expect(await repos.trees.listNodes('missing')).toEqual([]);
      });

      it('getAncestorPath follows parent ids across branches, root first', async () => {
        const { t, a, c } = await seedMultiBranch();
        expect(await repos.trees.getAncestorPath(c[1]!.id)).toEqual([t[0], t[1], a[0], c[0], c[1]]);
        expect(await repos.trees.getAncestorPath(t[3]!.id)).toEqual(t);
        expect(await repos.trees.getAncestorPath('missing')).toEqual([]);
      });

      it('appendNodes is atomic and reports a taken (branch, seq) as ConflictError', async () => {
        const { tree, trunk } = await seedTree();
        const [n0] = makeChain(trunk, 1, null);
        await repos.trees.appendNodes([n0!], '2026-01-01T00:00:10.000Z');
        const ok = makeNode(trunk, 1, n0!.id);
        const dup = makeNode(trunk, 0, ok.id);
        const err = await repos.trees
          .appendNodes([ok, dup], '2026-09-09T00:00:00.000Z')
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(await repos.trees.getNode(ok.id)).toBeNull();
        expect(await repos.trees.getNode(dup.id)).toBeNull();
        expect((await repos.trees.getTree(tree.id))?.updatedAt).toBe('2026-01-01T00:00:10.000Z');
      });

      it('updateNode patches content, status, error, kind, usage and sources', async () => {
        const { trunk } = await seedTree();
        const n = makeNode(trunk, 0, null, { status: 'streaming', content: '' });
        await repos.trees.appendNodes([n], 'x');
        await repos.trees.updateNode(n.id, { content: 'partial' });
        expect((await repos.trees.getNode(n.id))?.content).toBe('partial');
        const sources = [{ url: 'https://example.org/a', title: 'A', excerpt: 'e' }];
        await repos.trees.updateNode(n.id, {
          status: 'complete',
          content: 'final',
          usage: { inputTokens: 5, outputTokens: 7 },
          sources,
        });
        expect(await repos.trees.getNode(n.id)).toEqual({
          ...n,
          status: 'complete',
          content: 'final',
          usage: { inputTokens: 5, outputTokens: 7 },
          sources,
        });
        await repos.trees.updateNode(n.id, {
          status: 'error',
          error: 'interrupted',
          errorKind: 'interrupted',
          usage: null,
          sources: null,
        });
        expect(await repos.trees.getAncestorPath(n.id)).toEqual([
          {
            ...n,
            content: 'final',
            status: 'error',
            error: 'interrupted',
            errorKind: 'interrupted',
          },
        ]);
        await repos.trees.updateNode(n.id, {});
        await repos.trees.updateNode('missing', { content: 'x' });
      });

      it('listStreamingNodes lists only the streaming nodes of the tree, oldest first', async () => {
        const { tree, trunk } = await seedTree();
        const u = makeNode(trunk, 0, null);
        const late = makeNode(trunk, 1, u.id, {
          status: 'streaming',
          createdAt: '2026-01-01T00:00:09.000Z',
        });
        const b = makeBranch(tree, { parentBranchId: trunk.id, branchPointNodeId: u.id });
        await repos.trees.createBranch(b);
        const early = makeNode(b, 0, u.id, {
          status: 'streaming',
          createdAt: '2026-01-01T00:00:02.000Z',
        });
        await repos.trees.appendNodes([u, late], 'x');
        await repos.trees.appendNodes([early], 'x');
        const other = await seedTree();
        await repos.trees.appendNodes(
          [makeNode(other.trunk, 0, null, { status: 'streaming' })],
          'x',
        );
        expect(await repos.trees.listStreamingNodes(tree.id)).toEqual([early, late]);
        await repos.trees.updateNode(late.id, { status: 'complete' });
        await repos.trees.updateNode(early.id, { status: 'error' });
        expect(await repos.trees.listStreamingNodes(tree.id)).toEqual([]);
      });

      it('importTree writes the tree, its branches, nodes and links', async () => {
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
            createdAt: `2026-01-01T00:00:${String(10 + i)}.000Z`,
          });
          branchesList.push(b);
          nodesList.push(...makeChain(b, 2, trunkNodes[i]!.id));
        }
        const links = [makeLink(trunkNodes[0]!, nodesList[31]!, { note: 'see' })];
        await repos.trees.importTree(tree, branchesList, nodesList, links);
        expect(await repos.trees.getTree(tree.id)).toEqual(tree);
        expect(await repos.trees.listBranches(tree.id)).toEqual(branchesList);
        const stored = await repos.trees.listNodes(tree.id);
        expect(new Set(stored)).toEqual(new Set(nodesList));
        expect(await repos.trees.listLinks(tree.id)).toEqual(links);
      });
    });

    describe('links', () => {
      it('createLink round-trips, bumps the tree and returns the existing link for a pair either way', async () => {
        const { tree, t, a } = await seedMultiBranch();
        const link = makeLink(t[3]!, a[1]!, { note: 'why', origin: 'ai' });
        expect(await repos.trees.createLink(link, '2026-05-01T00:00:00.000Z')).toEqual({
          link,
          created: true,
        });
        expect(await repos.trees.getLink(link.id)).toEqual(link);
        expect((await repos.trees.getTree(tree.id))?.updatedAt).toBe('2026-05-01T00:00:00.000Z');

        const reversed = makeLink(a[1]!, t[3]!);
        expect(await repos.trees.createLink(reversed, '2026-06-01T00:00:00.000Z')).toEqual({
          link,
          created: false,
        });
        expect(await repos.trees.getLink(reversed.id)).toBeNull();
        expect((await repos.trees.getTree(tree.id))?.updatedAt).toBe('2026-05-01T00:00:00.000Z');
        expect(await repos.trees.getLink('missing')).toBeNull();
      });

      it('listLinks is oldest first, ties by id', async () => {
        const { tree, t } = await seedMultiBranch();
        const later = makeLink(t[0]!, t[1]!, { createdAt: '2026-01-04T00:00:00.000Z' });
        const tied = [makeLink(t[0]!, t[2]!), makeLink(t[0]!, t[3]!), makeLink(t[1]!, t[2]!)];
        for (const l of [later, ...tied]) await repos.trees.createLink(l, 'x');
        expect(await repos.trees.listLinks(tree.id)).toEqual([
          ...[...tied].sort((x, y) => byBytes(x.id, y.id)),
          later,
        ]);
        expect(await repos.trees.listLinks('missing')).toEqual([]);
      });

      it('createLink to a message that does not exist is NotFoundError, and writes nothing', async () => {
        const { tree, t } = await seedMultiBranch();
        const ghost = makeNode(makeBranch(tree), 0, null);
        await expect(
          repos.trees.createLink(makeLink(t[0]!, ghost), '2031-01-01T00:00:00.000Z'),
        ).rejects.toBeInstanceOf(NotFoundError);
        expect(await repos.trees.listLinks(tree.id)).toEqual([]);
        expect((await repos.trees.getTree(tree.id))?.updatedAt).not.toBe(
          '2031-01-01T00:00:00.000Z',
        );
      });

      it('updateLink patches the note; deleteLink removes it once', async () => {
        const { t } = await seedMultiBranch();
        const link = makeLink(t[0]!, t[2]!);
        await repos.trees.createLink(link, 'x');
        expect(await repos.trees.updateLink(link.id, { note: 'n', updatedAt: 'later' })).toEqual({
          ...link,
          note: 'n',
          updatedAt: 'later',
        });
        expect(
          await repos.trees.updateLink(link.id, { note: null, updatedAt: 'later2' }),
        ).toMatchObject({ note: null });
        expect(await repos.trees.updateLink('missing', { note: 'n', updatedAt: 'x' })).toBeNull();
        expect(await repos.trees.deleteLink(link.id)).toBe(true);
        expect(await repos.trees.deleteLink(link.id)).toBe(false);
        expect(await repos.trees.getLink(link.id)).toBeNull();
      });
    });

    describe('summaries', () => {
      it('get/put round-trip and upsert on the (anchor, hash, model) key', async () => {
        const { tree, trunk } = await seedTree();
        const [n] = makeChain(trunk, 1, null);
        await repos.trees.appendNodes([n!], 'x');
        const rec = summaryOf(tree, n!, { sourceHash: 'abc', model: 'm1', content: 'first' });
        expect(await repos.summaries.getSummary(n!.id, 'abc', 'm1')).toBeNull();
        await repos.summaries.putSummary(rec);
        expect(await repos.summaries.getSummary(n!.id, 'abc', 'm1')).toEqual(rec);
        const replaced = { ...rec, content: 'second', providerId: 'anthropic', createdAt: 'y' };
        await repos.summaries.putSummary(replaced);
        expect(await repos.summaries.getSummary(n!.id, 'abc', 'm1')).toEqual(replaced);
        await repos.summaries.putSummary({ ...rec, model: 'm2', content: 'other model' });
        expect((await repos.summaries.getSummary(n!.id, 'abc', 'm2'))?.content).toBe('other model');
        expect((await repos.summaries.getSummary(n!.id, 'abc', 'm1'))?.content).toBe('second');
        expect(await repos.summaries.getSummary(n!.id, 'other-hash', 'm1')).toBeNull();
      });
    });

    describe('shares', () => {
      it('create / get / getByToken round-trip with the tree title', async () => {
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
        expect(await repos.shares.getShare('missing')).toBeNull();
        expect(await repos.shares.getShareByToken('missing')).toBeNull();
      });

      it("listShares lists the account's shares, newest first, ties by id", async () => {
        const { tree } = await seedTree({ title: 'T' });
        const old = makeShare(tree, { createdAt: '2026-01-01T00:00:00.000Z' });
        const tied = [0, 1, 2].map(() => makeShare(tree));
        const newest = makeShare(tree, { createdAt: '2026-03-01T00:00:00.000Z' });
        for (const s of [old, ...tied, newest]) await repos.shares.createShare(s, null);
        await repos.shares.createShare(makeShare((await seedTree()).tree), null);
        expect((await repos.shares.listShares(tree.accountId)).map((s) => s.id)).toEqual([
          newest.id,
          ...tied.map((s) => s.id).sort(byBytes),
          old.id,
        ]);
        expect((await repos.shares.listShares(tree.accountId))[0]?.treeTitle).toBe('T');
      });

      it('updateShare patches fields and replaces, deletes or keeps the snapshot', async () => {
        const { tree } = await seedTree({ title: 'T' });
        const share = makeShare(tree);
        await repos.shares.createShare(share, '{"v":1}');
        const renamed = await repos.shares.updateShare(share.id, {
          title: 'New title',
          expiresAt: null,
        });
        expect(renamed).toEqual({ ...share, title: 'New title', treeTitle: 'T' });
        expect(await repos.shares.getSnapshot(share.id)).toBe('{"v":1}');
        const republished = await repos.shares.updateShare(
          share.id,
          { version: 2, publishedAt: '2026-04-01T00:00:00.000Z' },
          '{"v":2}',
        );
        expect(republished).toMatchObject({ version: 2, publishedAt: '2026-04-01T00:00:00.000Z' });
        expect(await repos.shares.getSnapshot(share.id)).toBe('{"v":2}');
        const revoked = await repos.shares.updateShare(
          share.id,
          { revokedAt: '2026-05-01T00:00:00.000Z' },
          null,
        );
        expect(revoked?.revokedAt).toBe('2026-05-01T00:00:00.000Z');
        expect(await repos.shares.getSnapshot(share.id)).toBeNull();
        expect(await repos.shares.updateShare('missing', { title: 'x' }, '{}')).toBeNull();
        expect(await repos.shares.getSnapshot('missing')).toBeNull();
      });

      it('deleteShare removes the share with its snapshot, once', async () => {
        const { tree } = await seedTree();
        const share = makeShare(tree);
        const kept = makeShare(tree);
        await repos.shares.createShare(share, '{"gone":true}');
        await repos.shares.createShare(kept, '{}');
        expect(await repos.shares.deleteShare(share.id)).toBe(true);
        expect(await repos.shares.getShare(share.id)).toBeNull();
        expect(await repos.shares.getSnapshot(share.id)).toBeNull();
        expect(await repos.shares.getSnapshot(kept.id)).toBe('{}');
        expect(await repos.shares.deleteShare(share.id)).toBe(false);
      });

      it('incrementViewCount is additive, a no-op for unknown shares', async () => {
        const { tree } = await seedTree();
        const share = makeShare(tree);
        await repos.shares.createShare(share, '{}');
        await Promise.all([
          repos.shares.incrementViewCount(share.id),
          repos.shares.incrementViewCount(share.id),
          repos.shares.incrementViewCount(share.id),
        ]);
        expect((await repos.shares.getShare(share.id))?.viewCount).toBe(3);
        await repos.shares.incrementViewCount('missing');
      });
    });

    describe('account settings', () => {
      it('has none until the first save, then upserts per account', async () => {
        const a = uid('acct');
        const b = uid('acct');
        expect(await repos.settings.getSettings(a)).toBeNull();
        await repos.settings.putSettings(a, { systemPrompt: 'First' }, '2026-01-01T00:00:00.000Z');
        expect(await repos.settings.getSettings(a)).toEqual({ systemPrompt: 'First' });
        await repos.settings.putSettings(a, { systemPrompt: null }, '2026-01-03T00:00:00.000Z');
        expect(await repos.settings.getSettings(a)).toEqual({ systemPrompt: null });
        expect(await repos.settings.getSettings(b)).toBeNull();
      });
    });
  });
}
