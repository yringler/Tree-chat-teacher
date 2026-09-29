import type { Branch, ChatNode } from '@tangent/shared';
import { ValidationError } from './errors.js';

/**
 * Pure helpers over an in-memory tree (all branches + nodes of one tree).
 * Used by the Angular app (outline, navigation, breadcrumbs), share
 * projection and exports.
 */
export interface TreeIndex {
  trunk: Branch;
  branches: ReadonlyMap<string, Branch>;
  nodes: ReadonlyMap<string, ChatNode>;
  /** Nodes of each branch ordered by seq. Every branch has an entry (possibly empty). */
  nodesByBranch: ReadonlyMap<string, readonly ChatNode[]>;
  /** Child branches of each branch in outline order. Every branch has an entry. */
  childBranches: ReadonlyMap<string, readonly Branch[]>;
  /** Branches hanging off each node, in outline order. Only nodes with children have entries. */
  branchesAtNode: ReadonlyMap<string, readonly Branch[]>;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Outline order for sibling branches: by the branch point's seq, then
 * createdAt, then id.
 * Throws ValidationError if there is not exactly one trunk.
 */
export function indexTree(branches: readonly Branch[], nodes: readonly ChatNode[]): TreeIndex {
  const trunks = branches.filter((b) => b.parentBranchId === null);
  const trunk = trunks[0];
  if (trunk === undefined || trunks.length !== 1) {
    throw new ValidationError(`expected exactly one trunk branch, found ${trunks.length}`);
  }

  const branchMap = new Map<string, Branch>();
  for (const b of branches) branchMap.set(b.id, b);

  const nodeMap = new Map<string, ChatNode>();
  const byBranch = new Map<string, ChatNode[]>();
  for (const b of branches) byBranch.set(b.id, []);
  for (const n of nodes) {
    nodeMap.set(n.id, n);
    byBranch.get(n.branchId)?.push(n);
  }
  for (const list of byBranch.values()) list.sort((a, b) => a.seq - b.seq);

  const pointSeq = (b: Branch): number => {
    const point = b.branchPointNodeId === null ? undefined : nodeMap.get(b.branchPointNodeId);
    return point === undefined ? Number.POSITIVE_INFINITY : point.seq;
  };
  const outlineOrder = (a: Branch, b: Branch): number => {
    const bySeq = pointSeq(a) - pointSeq(b);
    if (bySeq !== 0 && !Number.isNaN(bySeq)) return bySeq;
    return compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id);
  };

  const children = new Map<string, Branch[]>();
  for (const b of branches) children.set(b.id, []);
  const atNode = new Map<string, Branch[]>();
  for (const b of branches) {
    if (b.parentBranchId !== null) children.get(b.parentBranchId)?.push(b);
    if (b.branchPointNodeId !== null) {
      const list = atNode.get(b.branchPointNodeId);
      if (list) list.push(b);
      else atNode.set(b.branchPointNodeId, [b]);
    }
  }
  for (const list of children.values()) list.sort(outlineOrder);
  for (const list of atNode.values()) list.sort(outlineOrder);

  return {
    trunk,
    branches: branchMap,
    nodes: nodeMap,
    nodesByBranch: byBranch,
    childBranches: children,
    branchesAtNode: atNode,
  };
}

export interface OutlineItem {
  branch: Branch;
  depth: number;
  /** Messages in this branch (excluding descendants). */
  messageCount: number;
  /** The node this branch hangs off (in the parent branch). null for the trunk. */
  forkNode: ChatNode | null;
  children: OutlineItem[];
}

/** Outline rooted at the trunk. */
export function buildOutline(index: TreeIndex): OutlineItem {
  const visited = new Set<string>();
  const build = (branch: Branch, depth: number): OutlineItem => {
    visited.add(branch.id);
    const kids = (index.childBranches.get(branch.id) ?? []).filter((c) => !visited.has(c.id));
    return {
      branch,
      depth,
      messageCount: index.nodesByBranch.get(branch.id)?.length ?? 0,
      forkNode:
        branch.branchPointNodeId === null
          ? null
          : (index.nodes.get(branch.branchPointNodeId) ?? null),
      children: kids.map((c) => build(c, depth + 1)),
    };
  };
  return build(index.trunk, 0);
}

/** Depth-first flattening of the outline (trunk first). */
export function flattenOutline(root: OutlineItem): OutlineItem[] {
  const out: OutlineItem[] = [];
  const walk = (item: OutlineItem): void => {
    out.push(item);
    for (const c of item.children) walk(c);
  };
  walk(root);
  return out;
}

/** Trunk → branch (inclusive). Empty if unknown. */
export function branchChain(index: TreeIndex, branchId: string): Branch[] {
  const chain: Branch[] = [];
  const seen = new Set<string>();
  let cur = index.branches.get(branchId);
  while (cur !== undefined && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentBranchId === null ? undefined : index.branches.get(cur.parentBranchId);
  }
  return chain.reverse();
}

/** Root → node (inclusive), following parentId. Empty if unknown. */
export function pathToNode(index: TreeIndex, nodeId: string): ChatNode[] {
  const path: ChatNode[] = [];
  const seen = new Set<string>();
  let cur = index.nodes.get(nodeId);
  while (cur !== undefined && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parentId === null ? undefined : index.nodes.get(cur.parentId);
  }
  return path.reverse();
}

/** Root → branch leaf: ancestors up to the branch point, then the branch's own nodes. */
export function branchPath(index: TreeIndex, branchId: string): ChatNode[] {
  const branch = index.branches.get(branchId);
  if (branch === undefined) return [];
  const prefix =
    branch.branchPointNodeId === null ? [] : pathToNode(index, branch.branchPointNodeId);
  return [...prefix, ...(index.nodesByBranch.get(branchId) ?? [])];
}

export function branchLeaf(index: TreeIndex, branchId: string): ChatNode | null {
  const list = index.nodesByBranch.get(branchId);
  return list?.[list.length - 1] ?? null;
}

/** True if the branch or any ancestor branch is private. Unknown branches are not private. */
export function isEffectivelyPrivate(index: TreeIndex, branchId: string): boolean {
  return branchChain(index, branchId).some((b) => b.isPrivate);
}

/** All branches strictly below `branchId`, depth-first. */
export function descendantBranches(index: TreeIndex, branchId: string): Branch[] {
  const out: Branch[] = [];
  const seen = new Set<string>([branchId]);
  const walk = (id: string): void => {
    for (const child of index.childBranches.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      walk(child.id);
    }
  };
  walk(branchId);
  return out;
}

export type NavDirection = 'parent' | 'nextSibling' | 'prevSibling' | 'firstChild';

export interface NavTarget {
  branchId: string;
  /** Node to scroll to / focus (e.g. the branch point when moving to the parent). */
  focusNodeId: string | null;
}

function firstNodeId(index: TreeIndex, branchId: string): string | null {
  return index.nodesByBranch.get(branchId)?.[0]?.id ?? null;
}

/**
 * Keyboard navigation between branches.
 * - parent: the parent branch, focusing the branch point node;
 * - next/prevSibling: siblings share the same parent branch (outline order), no wrap-around;
 *   focuses the sibling's first node (null if it is empty); the trunk has no siblings;
 * - firstChild: first child branch in outline order, focusing its first node (null if empty).
 * Returns null when there is nowhere to go (or the branch is unknown).
 */
export function navigate(
  index: TreeIndex,
  branchId: string,
  direction: NavDirection,
): NavTarget | null {
  const branch = index.branches.get(branchId);
  if (branch === undefined) return null;
  switch (direction) {
    case 'parent': {
      if (branch.parentBranchId === null || !index.branches.has(branch.parentBranchId)) return null;
      return { branchId: branch.parentBranchId, focusNodeId: branch.branchPointNodeId };
    }
    case 'nextSibling':
    case 'prevSibling': {
      if (branch.parentBranchId === null) return null;
      const siblings = index.childBranches.get(branch.parentBranchId) ?? [];
      const i = siblings.findIndex((b) => b.id === branchId);
      if (i < 0) return null;
      const target = siblings[direction === 'nextSibling' ? i + 1 : i - 1];
      if (target === undefined) return null;
      return { branchId: target.id, focusNodeId: firstNodeId(index, target.id) };
    }
    case 'firstChild': {
      const child = index.childBranches.get(branchId)?.[0];
      if (child === undefined) return null;
      return { branchId: child.id, focusNodeId: firstNodeId(index, child.id) };
    }
  }
}
