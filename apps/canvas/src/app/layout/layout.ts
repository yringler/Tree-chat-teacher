import type { TreeIndex } from '@tangent/core/tree';
import type { Branch } from '@tangent/shared';

/*
 * The canvas layout: every branch is a *lane* (a column of message cards),
 * and a child lane hangs to the right of the message it forks from. Pure:
 * it takes the tree, the measured size of each lane (heights come from the
 * DOM) and the folded lanes, and returns where everything goes.
 *
 * Placement is a contour sweep. Lanes are placed depth-first in outline
 * order; each column keeps the lowest edge placed in it so far (its
 * contour). A child wants its head level with the card it forks from; it is
 * pushed down until none of the columns its subtree spans overlap what is
 * already there. Nothing is ever pushed up, so a connector always runs
 * rightwards and never backwards.
 */

export interface LaneMeasure {
  /** Height of the lane's box in canvas units. */
  height: number;
  /** Top (relative to the lane) and height of each message card. */
  cards: ReadonlyMap<string, { top: number; height: number }>;
}

export interface LayoutOptions {
  laneWidth: number;
  gapX: number;
  gapY: number;
  /** Height assumed for a lane that has not been measured yet. */
  defaultLaneHeight: number;
  /** Height of a folded lane's capsule. */
  collapsedHeight: number;
  /** Where a connector lands on a lane: this far below its top. */
  headAnchor: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  laneWidth: 420,
  gapX: 72,
  gapY: 28,
  defaultLaneHeight: 240,
  collapsedHeight: 92,
  headAnchor: 26,
};

export interface LanePlacement {
  branch: Branch;
  x: number;
  y: number;
  width: number;
  height: number;
  column: number;
  depth: number;
  collapsed: boolean;
  /** Lanes hidden under this one when it is collapsed. */
  hiddenBranches: number;
}

export interface Connector {
  parentId: string;
  childId: string;
  mode: Branch['contextMode'];
  /** Right edge of the fork card, vertically centred on it. */
  from: { x: number; y: number };
  /** Left edge of the child lane, at its head. */
  to: { x: number; y: number };
  /** The SVG path (`M … C …`). */
  d: string;
}

export interface Layout {
  lanes: LanePlacement[];
  byId: ReadonlyMap<string, LanePlacement>;
  connectors: Connector[];
  width: number;
  height: number;
}

interface Subtree {
  branch: Branch;
  children: Subtree[];
  collapsed: boolean;
  hidden: number;
  /** Own lane height. */
  height: number;
}

/** Per-column vertical extent of a placed subtree, relative to its root lane's top. */
interface Extent {
  top: number;
  bottom: number;
}

function buildSubtree(
  index: TreeIndex,
  branch: Branch,
  measures: ReadonlyMap<string, LaneMeasure>,
  collapsed: ReadonlySet<string>,
  opts: LayoutOptions,
  seen: Set<string>,
): Subtree {
  seen.add(branch.id);
  const kids = (index.childBranches.get(branch.id) ?? []).filter((c) => !seen.has(c.id));
  const isCollapsed = collapsed.has(branch.id) && kids.length > 0;
  if (isCollapsed) {
    return {
      branch,
      children: [],
      collapsed: true,
      hidden: countBranches(index, branch.id),
      height: opts.collapsedHeight,
    };
  }
  return {
    branch,
    children: kids.map((c) => buildSubtree(index, c, measures, collapsed, opts, seen)),
    collapsed: false,
    hidden: 0,
    height: measures.get(branch.id)?.height ?? opts.defaultLaneHeight,
  };
}

function countBranches(index: TreeIndex, branchId: string): number {
  let n = 0;
  const seen = new Set<string>([branchId]);
  const walk = (id: string): void => {
    for (const c of index.childBranches.get(id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      n++;
      walk(c.id);
    }
  };
  walk(branchId);
  return n;
}

/** Where (relative to the lane top) a child should be level with its fork card. */
function forkTop(
  parent: Branch,
  child: Branch,
  measures: ReadonlyMap<string, LaneMeasure>,
  opts: LayoutOptions,
): number {
  const card = child.branchPointNodeId
    ? measures.get(parent.id)?.cards.get(child.branchPointNodeId)
    : undefined;
  // Align the child's head anchor with the middle of the fork card.
  return card ? card.top + card.height / 2 - opts.headAnchor : 0;
}

/**
 * Lays out `sub` with its root lane at column 0, y 0 (local coordinates).
 * Returns the local placements and the per-column extents the subtree
 * occupies (index 0 = the root lane's column).
 */
function place(
  sub: Subtree,
  measures: ReadonlyMap<string, LaneMeasure>,
  opts: LayoutOptions,
  depth: number,
  out: { lane: Subtree; x: number; y: number; column: number; depth: number }[],
): Extent[] {
  const extents: Extent[] = [{ top: 0, bottom: sub.height }];
  out.push({ lane: sub, x: 0, y: 0, column: 0, depth });
  // Contour of the columns to the right of the root, relative to the root's top.
  const contour: number[] = [sub.height];
  for (const child of sub.children) {
    const local: typeof out = [];
    const childExtents = place(child, measures, opts, depth + 1, local);
    const wanted = forkTop(sub.branch, child.branch, measures, opts);
    let y = Math.max(0, wanted);
    for (let k = 0; k < childExtents.length; k++) {
      const col = 1 + k;
      const floor = contour[col];
      const ext = childExtents[k]!;
      if (floor !== undefined && floor > Number.NEGATIVE_INFINITY) {
        y = Math.max(y, floor + opts.gapY - ext.top);
      }
    }
    for (let k = 0; k < childExtents.length; k++) {
      const col = 1 + k;
      const ext = childExtents[k]!;
      contour[col] = Math.max(contour[col] ?? Number.NEGATIVE_INFINITY, y + ext.bottom);
      const cur = extents[col];
      extents[col] = cur
        ? { top: Math.min(cur.top, y + ext.top), bottom: Math.max(cur.bottom, y + ext.bottom) }
        : { top: y + ext.top, bottom: y + ext.bottom };
    }
    for (const p of local) {
      out.push({ ...p, x: p.x + opts.laneWidth + opts.gapX, y: p.y + y, column: p.column + 1 });
    }
  }
  return extents;
}

export function layoutTree(
  index: TreeIndex,
  measures: ReadonlyMap<string, LaneMeasure>,
  collapsed: ReadonlySet<string>,
  opts: LayoutOptions = DEFAULT_LAYOUT,
): Layout {
  const root = buildSubtree(index, index.trunk, measures, collapsed, opts, new Set());
  const placed: { lane: Subtree; x: number; y: number; column: number; depth: number }[] = [];
  place(root, measures, opts, 0, placed);

  const lanes: LanePlacement[] = placed.map((p) => ({
    branch: p.lane.branch,
    x: p.x,
    y: p.y,
    width: opts.laneWidth,
    height: p.lane.height,
    column: p.column,
    depth: p.depth,
    collapsed: p.lane.collapsed,
    hiddenBranches: p.lane.hidden,
  }));
  const byId = new Map(lanes.map((l) => [l.branch.id, l]));

  const connectors: Connector[] = [];
  for (const lane of lanes) {
    const b = lane.branch;
    if (!b.parentBranchId || !b.branchPointNodeId) continue;
    const parent = byId.get(b.parentBranchId);
    if (!parent) continue;
    const card = measures.get(parent.branch.id)?.cards.get(b.branchPointNodeId);
    const fromY = card ? parent.y + card.top + card.height / 2 : parent.y + opts.headAnchor;
    const from = { x: parent.x + parent.width, y: fromY };
    const to = { x: lane.x, y: lane.y + opts.headAnchor };
    connectors.push({
      parentId: parent.branch.id,
      childId: b.id,
      mode: b.contextMode,
      from,
      to,
      d: curve(from, to),
    });
  }

  let width = 0;
  let height = 0;
  for (const l of lanes) {
    width = Math.max(width, l.x + l.width);
    height = Math.max(height, l.y + l.height);
  }
  return { lanes, byId, connectors, width, height };
}

/** A horizontal S-curve: leaves the fork card to the right, lands on the lane head from the left. */
export function curve(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const dx = Math.max(24, (to.x - from.x) / 2);
  return `M ${r(from.x)} ${r(from.y)} C ${r(from.x + dx)} ${r(from.y)}, ${r(to.x - dx)} ${r(to.y)}, ${r(to.x)} ${r(to.y)}`;
}

function r(n: number): number {
  return Math.round(n * 10) / 10;
}
