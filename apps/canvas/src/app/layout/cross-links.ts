import type { TreeIndex } from '@tangent/core/tree';
import type { NodeLink } from '@tangent/shared';
import { DEFAULT_LAYOUT, type Layout } from './layout';

/*
 * Where the lines between linked messages go (NodeLink). Pure, like
 * `layoutTree`: it takes the tree, the placed lanes and the measured cards,
 * and returns one bowed curve per link in world coordinates, with its
 * midpoint (where the link's glyph sits).
 *
 * Each end leaves its lane on the edge facing the other end, level with the
 * middle of its card. A card on a lane folded away (or inside a folded
 * capsule) has no box: its end moves to the nearest lane still placed, at
 * that lane's head, and the line dims. A card not measured yet uses its
 * lane's head too.
 */

export interface CrossLinkPoint {
  x: number;
  y: number;
}

/** One end of a drawn link. */
export interface CrossLinkEnd {
  nodeId: string;
  /** The message's own lane. */
  branchId: string;
  /** The lane the end is drawn on: its own, or the nearest placed ancestor when folded away. */
  laneId: string;
  /** The card is hidden (its lane folded away or folded into a capsule). */
  folded: boolean;
  point: CrossLinkPoint;
}

export interface CrossLink {
  id: string;
  link: NodeLink;
  /** The link's source end, then its target. */
  ends: readonly [CrossLinkEnd, CrossLinkEnd];
  /** Where the glyph sits: the curve's point halfway. */
  mid: CrossLinkPoint;
  /** The SVG path (`M … Q …` between columns, `M … C …` within one). */
  d: string;
}

/** Card boxes as the LayoutStore keeps them (top relative to the lane). */
export type CardBox = (branchId: string, nodeId: string) => { top: number; height: number } | null;

/** How far a curve between two cards of one column bulges out of it, at least and at most. */
const SIDE_BOW_MIN = 36;
const SIDE_BOW_MAX = 150;
/** How far a curve between columns rises above the straight line, at least and at most. */
const ARC_BOW_MIN = 18;
const ARC_BOW_MAX = 90;

interface Anchor {
  laneId: string;
  folded: boolean;
  x: number;
  width: number;
  y: number;
}

/**
 * The curves for `links`, in their order. A link whose message isn't in the
 * tree, or whose ends land on the same point (both folded into one lane),
 * is left out.
 */
export function crossLinkGeometry(
  index: TreeIndex,
  layout: Pick<Layout, 'byId'>,
  links: readonly NodeLink[],
  cardOf: CardBox,
  headAnchor: number = DEFAULT_LAYOUT.headAnchor,
): CrossLink[] {
  const out: CrossLink[] = [];
  for (const link of links) {
    const a = anchorOf(index, layout, link.sourceNodeId, cardOf, headAnchor);
    const b = anchorOf(index, layout, link.targetNodeId, cardOf, headAnchor);
    if (!a || !b) continue;
    const ca = a.x + a.width / 2;
    const cb = b.x + b.width / 2;
    // Facing edges between columns; within one column both ends leave on the right.
    const sameColumn = Math.abs(ca - cb) < 1;
    const from = { x: sameColumn || ca < cb ? a.x + a.width : a.x, y: a.y };
    const to = { x: sameColumn || cb < ca ? b.x + b.width : b.x, y: b.y };
    if (from.x === to.x && from.y === to.y) continue;
    const curve = sameColumn ? sideCurve(from, to) : arc(from, to);
    out.push({
      id: link.id,
      link,
      ends: [end(index, link.sourceNodeId, a, from), end(index, link.targetNodeId, b, to)],
      mid: curve.mid,
      d: curve.d,
    });
  }
  return out;
}

/** Where a node's end is drawn: its card, or the head of the nearest lane still placed. */
function anchorOf(
  index: TreeIndex,
  layout: Pick<Layout, 'byId'>,
  nodeId: string,
  cardOf: CardBox,
  headAnchor: number,
): Anchor | null {
  const node = index.nodes.get(nodeId);
  if (!node) return null;
  let branch = index.branches.get(node.branchId);
  const seen = new Set<string>();
  while (branch && !layout.byId.has(branch.id) && !seen.has(branch.id)) {
    seen.add(branch.id);
    branch = branch.parentBranchId ? index.branches.get(branch.parentBranchId) : undefined;
  }
  const lane = branch ? layout.byId.get(branch.id) : undefined;
  if (!lane) return null;
  const folded = lane.branch.id !== node.branchId || lane.collapsed;
  const card = folded ? null : cardOf(lane.branch.id, nodeId);
  return {
    laneId: lane.branch.id,
    folded,
    x: lane.x,
    width: lane.width,
    y: card ? lane.y + card.top + card.height / 2 : lane.y + headAnchor,
  };
}

function end(index: TreeIndex, nodeId: string, a: Anchor, point: CrossLinkPoint): CrossLinkEnd {
  return {
    nodeId,
    branchId: index.nodes.get(nodeId)?.branchId ?? a.laneId,
    laneId: a.laneId,
    folded: a.folded,
    point,
  };
}

/**
 * Between columns: a quadratic arc bowed upwards. Only up, so the point
 * halfway stays halfway across (in the gap between adjacent columns), and
 * the arc rises more the further apart the columns are.
 */
function arc(from: CrossLinkPoint, to: CrossLinkPoint): { d: string; mid: CrossLinkPoint } {
  const bow = clamp(Math.abs(to.x - from.x) * 0.2, ARC_BOW_MIN, ARC_BOW_MAX);
  const c = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - bow };
  return {
    d: `M ${r(from.x)} ${r(from.y)} Q ${r(c.x)} ${r(c.y)}, ${r(to.x)} ${r(to.y)}`,
    // A quadratic's point at t = ½: (from + 2c + to) / 4.
    mid: { x: (from.x + 2 * c.x + to.x) / 4, y: (from.y + 2 * c.y + to.y) / 4 },
  };
}

/** Within a column: a curve out of the right edge and back, bulging further the further apart. */
function sideCurve(from: CrossLinkPoint, to: CrossLinkPoint): { d: string; mid: CrossLinkPoint } {
  const bow = clamp(SIDE_BOW_MIN + Math.abs(to.y - from.y) * 0.25, SIDE_BOW_MIN, SIDE_BOW_MAX);
  return {
    d: `M ${r(from.x)} ${r(from.y)} C ${r(from.x + bow)} ${r(from.y)}, ${r(to.x + bow)} ${r(to.y)}, ${r(to.x)} ${r(to.y)}`,
    // A cubic's point at t = ½: (from + 3c1 + 3c2 + to) / 8.
    mid: { x: (from.x + to.x) / 2 + 0.75 * bow, y: (from.y + to.y) / 2 },
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function r(n: number): number {
  return Math.round(n * 10) / 10;
}
