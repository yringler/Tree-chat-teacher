import {
  clip,
  plainText,
  splitTangents,
  type Branch,
  type ChatNode,
  type NodeLink,
} from '@tangent/shared';
import { branchChain, type NavTarget, type TreeIndex } from './tree.js';

/**
 * Pure helpers over a tree's cross-links (NodeLink). A link is stored
 * directed (where it was made from) but shown on both of its messages, so
 * everything here looks links up by either end. Used by the three apps and
 * by the repositories (the pair key).
 */

/** Longest snippet `describeEndpoint` returns, in characters. */
export const LINK_SNIPPET_CHARS = 90;

/** How an app names a branch (Learn strips the "Branch: " prefix, for example). */
export type BranchTitleOf = (branch: Branch) => string;

const ownTitle: BranchTitleOf = (b) => b.title;

/** The unordered pair two nodes make: the same whichever way round they are linked. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Links by node id, each link under both of its ends, in the given order. */
export function indexLinks(links: readonly NodeLink[]): Map<string, NodeLink[]> {
  const out = new Map<string, NodeLink[]>();
  const add = (nodeId: string, link: NodeLink): void => {
    const list = out.get(nodeId);
    if (list) list.push(link);
    else out.set(nodeId, [link]);
  };
  for (const link of links) {
    add(link.sourceNodeId, link);
    if (link.targetNodeId !== link.sourceNodeId) add(link.targetNodeId, link);
  }
  return out;
}

/** The end of `link` that isn't `nodeId`. */
export function otherEnd(link: NodeLink, nodeId: string): string {
  return link.sourceNodeId === nodeId ? link.targetNodeId : link.sourceNodeId;
}

/** What a link chip shows about one end. */
export interface LinkEndpoint {
  node: ChatNode;
  branch: Branch;
  /** Branch titles, trunk first, down to the node's own branch. */
  crumbs: string[];
  /** The node is the first message of a tangent: show it as "Tangent: ‹title›". */
  isTangentHead: boolean;
  /** The message as plain text (no Markdown, no tangents block), at most LINK_SNIPPET_CHARS. */
  snippet: string;
}

/** One end of a link as the apps show it; null when the node isn't in the tree (any more). */
export function describeEndpoint(
  index: TreeIndex,
  nodeId: string,
  titleOf: BranchTitleOf = ownTitle,
): LinkEndpoint | null {
  const node = index.nodes.get(nodeId);
  const branch = node ? index.branches.get(node.branchId) : undefined;
  if (!node || !branch) return null;
  return {
    node,
    branch,
    crumbs: branchChain(index, branch.id).map(titleOf),
    isTangentHead: isTangentHead(index, node),
    snippet: clip(messageText(node), LINK_SNIPPET_CHARS),
  };
}

/** Where opening a link's end goes: its branch, focused on the message. Null for an unknown node. */
export function linkTarget(index: TreeIndex, nodeId: string): NavTarget | null {
  const node = index.nodes.get(nodeId);
  if (!node || !index.branches.has(node.branchId)) return null;
  return { branchId: node.branchId, focusNodeId: node.id };
}

export interface NodeSearchOptions {
  /** Nodes never returned (the link's source, nodes it is already linked to). */
  exclude?: ReadonlySet<string>;
  /** Most hits returned (default 20). */
  limit?: number;
  titleOf?: BranchTitleOf;
}

export interface NodeSearchHit {
  node: ChatNode;
  branch: Branch;
  /** A tangent's first message whose title matched: shown as "Tangent: ‹title›". */
  titleHit: boolean;
}

/**
 * Messages matching every word of `query` (case-insensitive), for the link
 * picker. Ranked: tangents whose title matches (by their first message),
 * then messages whose text matches, then messages that match only with
 * their branch's title; newest first within each. An empty query finds
 * nothing (the picker browses the outline instead).
 */
export function searchNodes(
  index: TreeIndex,
  query: string,
  options: NodeSearchOptions = {},
): NodeSearchHit[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const titleOf = options.titleOf ?? ownTitle;
  const limit = options.limit ?? 20;
  const all = (text: string): boolean => tokens.every((t) => text.includes(t));
  const titles = new Map<string, string>();
  const titleText = (branch: Branch): string => {
    let t = titles.get(branch.id);
    if (t === undefined) {
      t = titleOf(branch).toLowerCase();
      titles.set(branch.id, t);
    }
    return t;
  };

  const ranked: { hit: NodeSearchHit; tier: number }[] = [];
  for (const node of index.nodes.values()) {
    if (options.exclude?.has(node.id)) continue;
    const branch = index.branches.get(node.branchId);
    if (!branch) continue;
    const title = titleText(branch);
    const text = messageText(node).toLowerCase();
    const titleHit = isTangentHead(index, node) && all(title);
    const tier = titleHit ? 0 : all(text) ? 1 : all(`${text} ${title}`) ? 2 : -1;
    if (tier >= 0) ranked.push({ hit: { node, branch, titleHit }, tier });
  }
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      compare(b.hit.node.createdAt, a.hit.node.createdAt) ||
      compare(a.hit.node.id, b.hit.node.id),
  );
  return ranked.slice(0, Math.max(0, limit)).map((r) => r.hit);
}

/**
 * How many links touch each branch's messages (a link inside one branch
 * counts once), for outline badges. Branches without links have no entry.
 */
export function branchesWithLinks(
  index: TreeIndex,
  linksByNode: ReadonlyMap<string, readonly NodeLink[]>,
): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const [nodeId, links] of linksByNode) {
    const branchId = index.nodes.get(nodeId)?.branchId;
    if (branchId === undefined || links.length === 0) continue;
    let ids = seen.get(branchId);
    if (!ids) seen.set(branchId, (ids = new Set()));
    for (const link of links) ids.add(link.id);
  }
  return new Map([...seen].map(([branchId, ids]) => [branchId, ids.size]));
}

function isTangentHead(index: TreeIndex, node: ChatNode): boolean {
  const branch = index.branches.get(node.branchId);
  return branch !== undefined && branch.parentBranchId !== null && node.seq === 0;
}

function messageText(node: ChatNode): string {
  return plainText(splitTangents(node.content).body);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
