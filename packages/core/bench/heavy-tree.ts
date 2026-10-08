import type { Branch, ChatNode, ContextMode } from '@tangent/shared';

/*
 * A synthetic heavy tree for the scaling benchmarks: like the power-mode
 * perf harness's seeded demo tree (apps/e2e/perf/seed.ts), without a backend.
 * A trunk of `trunkExchanges` exchanges; from its last reply `fanout`
 * branches, each with 1–2 exchanges and `fanout` branches from its last
 * reply, down to `depth`. The spine (first children) is all `path` and its
 * leaf has `leafExchanges` exchanges; other branches mix in `summary`,
 * `message` and `independent`. Replies are ~900 characters, like the demo's.
 */

export interface HeavyTree {
  branches: Branch[];
  nodes: ChatNode[];
  trunk: Branch;
  /** Deepest branch on the spine. */
  spineLeaf: Branch;
  /** Branches without children. */
  leaves: Branch[];
  /** Deepest `summary` branch (its context hashes a long transcript). */
  deepSummary: Branch | null;
}

const TREE_ID = 'bench-tree';
const WORDS =
  'the branch keeps its context while every reply adds another idea about paths trees and summaries so a deep conversation grows'.split(
    ' ',
  );

function text(seed: number, chars: number): string {
  let out = '';
  let i = seed;
  while (out.length < chars) {
    out += WORDS[i % WORDS.length]! + (i % 17 === 0 ? '. ' : ' ');
    i = (i * 31 + 7) % 9973;
  }
  return out.slice(0, chars);
}

function modeFor(spine: boolean, n: number): ContextMode {
  if (spine) return 'path';
  const r = n % 10;
  if (r === 3 || r === 7) return 'summary';
  if (r === 5) return 'message';
  if (r === 9) return 'independent';
  return 'path';
}

export function buildHeavyTree(opts: {
  depth: number;
  fanout: number;
  trunkExchanges?: number;
  leafExchanges?: number;
}): HeavyTree {
  const trunkExchanges = opts.trunkExchanges ?? 3;
  const leafExchanges = opts.leafExchanges ?? 10;
  const branches: Branch[] = [];
  const nodes: ChatNode[] = [];
  const children = new Map<string, number>();
  let ids = 0;
  let clock = Date.UTC(2026, 0, 1);
  const at = (): string => new Date((clock += 1000)).toISOString();

  const makeBranch = (
    parent: Branch | null,
    point: ChatNode | null,
    mode: ContextMode,
    title: string,
  ): Branch => {
    const b: Branch = {
      id: `b${ids++}`,
      treeId: TREE_ID,
      parentBranchId: parent?.id ?? null,
      branchPointNodeId: point?.id ?? null,
      contextMode: parent ? mode : 'path',
      anchorQuote: null,
      title,
      titleSource: 'user',
      isPrivate: false,
      providerId: 'bench',
      model: 'bench-1',
      funding: 'own-key',
      createdAt: at(),
      updatedAt: at(),
    };
    branches.push(b);
    if (parent) children.set(parent.id, (children.get(parent.id) ?? 0) + 1);
    return b;
  };
  const own = new Map<string, ChatNode[]>();
  const add = (b: Branch, role: 'user' | 'assistant', content: string): ChatNode => {
    const list = own.get(b.id) ?? [];
    const prev = list.at(-1);
    const n: ChatNode = {
      id: `n${ids++}`,
      treeId: TREE_ID,
      branchId: b.id,
      parentId: prev?.id ?? b.branchPointNodeId,
      seq: list.length,
      role,
      content,
      status: 'complete',
      error: null,
      providerId: role === 'assistant' ? 'bench' : null,
      model: role === 'assistant' ? 'bench-1' : null,
      usage: null,
      createdAt: at(),
    };
    list.push(n);
    own.set(b.id, list);
    nodes.push(n);
    return n;
  };
  const exchange = (b: Branch, k: number): ChatNode => {
    add(b, 'user', text(k, 60));
    return add(b, 'assistant', text(k + 1, 900));
  };

  const trunk = makeBranch(null, null, 'path', 'Main thread');
  let last = exchange(trunk, 0);
  for (let i = 1; i < trunkExchanges; i++) last = exchange(trunk, i * 2);
  let counter = 0;
  let spineLeaf = trunk;
  let deepSummary: { b: Branch; depth: number } | null = null;
  const grow = (parent: Branch, point: ChatNode, level: number, spine: boolean): void => {
    if (level > opts.depth) return;
    for (let c = 0; c < opts.fanout; c++) {
      const onSpine = spine && c === 0;
      const mode = modeFor(onSpine, counter++);
      const b = makeBranch(parent, point, mode, `D${level} ${counter}`);
      const n = onSpine && level === opts.depth ? leafExchanges : 1 + (counter % 2);
      let reply = point;
      for (let i = 0; i < n; i++) reply = exchange(b, counter * 7 + i);
      if (onSpine && level === opts.depth) spineLeaf = b;
      if (mode === 'summary' && (!deepSummary || level > deepSummary.depth))
        deepSummary = { b, depth: level };
      grow(b, reply, level + 1, onSpine);
    }
  };
  grow(trunk, last, 1, true);
  const leaves = branches.filter((b) => !children.has(b.id));
  return {
    branches,
    nodes,
    trunk,
    spineLeaf,
    leaves,
    deepSummary: (deepSummary as { b: Branch } | null)?.b ?? null,
  };
}
