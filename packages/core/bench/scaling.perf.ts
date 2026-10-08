import { test } from 'vitest';
import type { Branch, ChatNode } from '@tangent/shared';
import { assembleContext } from '../src/context/assemble.js';
import { sha256Hex } from '../src/hash.js';
import { branchesWithLinks, indexLinks } from '../src/links.js';
import {
  branchChain,
  branchPath,
  buildOutline,
  descendantBranches,
  flattenOutline,
  indexTree,
  type TreeIndex,
} from '../src/tree.js';
import { buildHeavyTree, type HeavyTree } from './heavy-tree.js';

/*
 * Scaling of the pure tree and context code with tree size (not part of
 * `pnpm test`): `pnpm --filter @tangent/core bench`. Each case is timed per
 * operation at several tree sizes; the ratio columns compare with the
 * smallest tree (depth 5 × 2, the e2e perf harness's tree), next to the
 * ratio of node counts, so linear work keeps the two close and quadratic
 * work shows as the square.
 */

const SIZES = [
  { depth: 5, fanout: 2 },
  { depth: 6, fanout: 2 },
  { depth: 7, fanout: 2 },
  { depth: 5, fanout: 3 },
  { depth: 7, fanout: 3 },
];

/** Mean ms per call: warm up, then repeat until `budgetMs` has passed (at least 5 calls). */
function time(fn: () => unknown, budgetMs = 300): number {
  for (let i = 0; i < 3; i++) fn();
  let n = 0;
  const t0 = performance.now();
  let t = t0;
  while (n < 5 || t - t0 < budgetMs) {
    fn();
    n++;
    t = performance.now();
  }
  return (t - t0) / n;
}

const chainOf = (idx: TreeIndex, id: string): Branch[] => branchChain(idx, id);

/** What the server hands assembleContext: the chain and the ancestor path. */
function planInputs(idx: TreeIndex, b: Branch): { chain: Branch[]; path: ChatNode[] } {
  return { chain: chainOf(idx, b.id), path: branchPath(idx, b.id) };
}

function plan(t: HeavyTree, b: Branch, branches: readonly Branch[], nodes: readonly ChatNode[]) {
  return assembleContext({
    tree: { id: 'bench-tree', systemPrompt: 'You are helpful.' },
    branches,
    nodes,
    targetBranchId: b.id,
    targetNodeId: null,
    summaries: new Map(),
    budget: { maxInputTokens: 1_000_000 },
  });
}

/** TreeStore.applyNodes + every computed that depends on `detail` (per stream start/done). */
function upsertById<T extends { id: string }>(list: readonly T[], items: readonly T[]): T[] {
  const out = [...list];
  for (const item of items) {
    const i = out.findIndex((x) => x.id === item.id);
    if (i === -1) out.push(item);
    else out[i] = item;
  }
  return out;
}

test('scaling of tree utilities and context assembly', () => {
  const rows: Record<string, string | number>[] = [];
  const base: Record<string, number> = {};
  for (const size of SIZES) {
    const t = buildHeavyTree(size);
    const idx = indexTree(t.branches, t.nodes);
    const deep = planInputs(idx, t.spineLeaf);
    const leafInputs = t.leaves.map((b) => ({ b, ...planInputs(idx, b) }));
    const summaryInputs = t.deepSummary ? planInputs(idx, t.deepSummary) : null;
    const lastNode = t.nodes.at(-1)!;
    const results: Record<string, number> = {
      indexTree: time(() => indexTree(t.branches, t.nodes)),
      'buildOutline+flatten': time(() => flattenOutline(buildOutline(idx))),
      'detail update (store recompute)': time(() => {
        const nodes = upsertById(t.nodes, [{ ...lastNode }]);
        const i = indexTree(t.branches, nodes);
        flattenOutline(buildOutline(i));
        branchesWithLinks(i, indexLinks([]));
      }),
      'branchPath(spine leaf)': time(() => branchPath(idx, t.spineLeaf.id)),
      'depthOf every path message': time(() => {
        for (const n of deep.path) branchChain(idx, n.branchId);
      }),
      'descendantBranches(trunk)': time(() => descendantBranches(idx, t.trunk.id)),
      'assemble spine leaf (chain+path)': time(() => plan(t, t.spineLeaf, deep.chain, deep.path)),
      'assemble spine leaf (all nodes)': time(() => plan(t, t.spineLeaf, t.branches, t.nodes)),
      'assemble every leaf (chain+path)': time(() => {
        for (const l of leafInputs) plan(t, l.b, l.chain, l.path);
      }, 500),
    };
    if (summaryInputs && t.deepSummary)
      results['assemble deepest summary branch'] = time(() =>
        plan(t, t.deepSummary!, summaryInputs.chain, summaryInputs.path),
      );
    const row: Record<string, string | number> = {
      size: `d${size.depth}×${size.fanout}`,
      branches: t.branches.length,
      nodes: t.nodes.length,
      leaves: t.leaves.length,
      'spine path': deep.path.length,
    };
    if (Object.keys(base).length === 0) {
      Object.assign(base, results, { nodes: t.nodes.length, leaves: t.leaves.length });
    }
    row['nodes ×'] = +(t.nodes.length / base['nodes']!).toFixed(1);
    for (const [k, v] of Object.entries(results)) {
      row[k] = `${v < 0.01 ? v.toFixed(4) : v.toFixed(3)} ms (×${(v / base[k]!).toFixed(1)})`;
    }
    rows.push(row);
  }
  // One row per size, transposed so the cases read down the page.
  const keys = Object.keys(rows[0]!);
  console.log(
    keys
      .map((k) => `${k.padEnd(34)} ${rows.map((r) => String(r[k] ?? '').padStart(24)).join(' ')}`)
      .join('\n'),
  );

  // sha256 (pure JS) on transcripts the size a summary branch hashes.
  for (const kb of [10, 100, 1000]) {
    const s = 'x'.repeat(kb * 1024);
    console.log(`sha256Hex ${kb} KB: ${time(() => sha256Hex(s)).toFixed(2)} ms`);
  }
}, 600_000);
