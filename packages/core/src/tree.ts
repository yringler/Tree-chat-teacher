import type { Branch, ChatNode } from '@tangent/shared';

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

/**
 * Outline order for sibling branches: by the branch point's seq, then
 * createdAt, then id.
 * Throws ValidationError if there is not exactly one trunk.
 */
export function indexTree(branches: readonly Branch[], nodes: readonly ChatNode[]): TreeIndex {
  void branches;
  void nodes;
  throw new Error('not implemented');
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
  void index;
  throw new Error('not implemented');
}

/** Depth-first flattening of the outline (trunk first). */
export function flattenOutline(root: OutlineItem): OutlineItem[] {
  void root;
  throw new Error('not implemented');
}

/** Trunk → branch (inclusive). Empty if unknown. */
export function branchChain(index: TreeIndex, branchId: string): Branch[] {
  void index;
  void branchId;
  throw new Error('not implemented');
}

/** Root → node (inclusive), following parentId. Empty if unknown. */
export function pathToNode(index: TreeIndex, nodeId: string): ChatNode[] {
  void index;
  void nodeId;
  throw new Error('not implemented');
}

/** Root → branch leaf: ancestors up to the branch point, then the branch's own nodes. */
export function branchPath(index: TreeIndex, branchId: string): ChatNode[] {
  void index;
  void branchId;
  throw new Error('not implemented');
}

export function branchLeaf(index: TreeIndex, branchId: string): ChatNode | null {
  void index;
  void branchId;
  throw new Error('not implemented');
}

/** True if the branch or any ancestor branch is private. */
export function isEffectivelyPrivate(index: TreeIndex, branchId: string): boolean {
  void index;
  void branchId;
  throw new Error('not implemented');
}

/** All branches strictly below `branchId`, depth-first. */
export function descendantBranches(index: TreeIndex, branchId: string): Branch[] {
  void index;
  void branchId;
  throw new Error('not implemented');
}

export type NavDirection = 'parent' | 'nextSibling' | 'prevSibling' | 'firstChild';

export interface NavTarget {
  branchId: string;
  /** Node to scroll to / focus (e.g. the branch point when moving to the parent). */
  focusNodeId: string | null;
}

/**
 * Keyboard navigation between branches.
 * - parent: the parent branch, focusing the branch point node;
 * - next/prevSibling: siblings share the same parent branch (outline order), no wrap-around;
 * - firstChild: first child branch in outline order, focusing its first node.
 * Returns null when there is nowhere to go.
 */
export function navigate(index: TreeIndex, branchId: string, direction: NavDirection): NavTarget | null {
  void index;
  void branchId;
  void direction;
  throw new Error('not implemented');
}
