import {
  describeEndpoint,
  otherEnd,
  searchNodes,
  type BranchTitleOf,
  type LinkEndpoint,
} from '@tangent/core/links';
import { buildOutline, flattenOutline, type TreeIndex } from '@tangent/core/tree';
import type { NodeLink, Role } from '@tangent/shared';

/**
 * Pure view helpers behind RelatedLinks and NodePicker (ui/related-links.ts,
 * ui/node-picker.ts): what a link chip says and which rows the picker lists.
 * Only the tree helpers are imported (`@tangent/core/links`, `/tree`), so
 * the apps' main chunks don't pull in the ChatService.
 */

/** Between a link's branch titles ("Main thread › Why owls hum"). */
export const CRUMB_SEPARATOR = ' › ';

/** Most search results the picker lists. */
export const PICKER_SEARCH_LIMIT = 30;

/** Links by node id, each link under both of its ends (`indexLinks` in @tangent/core). */
export type LinksByNode = ReadonlyMap<string, readonly NodeLink[]>;

const ownTitle: BranchTitleOf = (b) => b.title;

/** One link as a chip under a message shows it: the other end, and the note. */
export interface RelatedLink {
  link: NodeLink;
  /** The other end: what opening the chip goes to. */
  nodeId: string;
  endpoint: LinkEndpoint;
  /** "Tangent: ‹title›" for a tangent's first message, else the message's snippet. */
  title: string;
  /** Where the other end lives (`endpointCrumbs`). */
  crumbs: string;
  /** Hover text: where, what and why. */
  tooltip: string;
}

/**
 * Where an end lives: its branch titles, trunk first. Shown as a tangent
 * ("Tangent: ‹title›"), its own title is left out (the title says it).
 */
export function endpointCrumbs(endpoint: LinkEndpoint, asTangent = endpoint.isTangentHead): string {
  return (asTangent ? endpoint.crumbs.slice(0, -1) : endpoint.crumbs).join(CRUMB_SEPARATOR);
}

/** "Tangent: ‹title›" for a tangent's first message, else its snippet. */
export function endpointTitle(endpoint: LinkEndpoint): string {
  if (endpoint.isTangentHead) {
    return `Tangent: ${endpoint.crumbs.at(-1) ?? endpoint.branch.title}`;
  }
  return endpoint.snippet || 'Empty message';
}

/**
 * The links of `nodeId`, resolved to their other ends, oldest first (the
 * order of `linksByNode`). A link whose other end isn't in the tree (any
 * more) is left out.
 */
export function relatedLinks(
  index: TreeIndex,
  linksByNode: LinksByNode,
  nodeId: string,
  titleOf: BranchTitleOf = ownTitle,
): RelatedLink[] {
  const out: RelatedLink[] = [];
  for (const link of linksByNode.get(nodeId) ?? []) {
    const other = otherEnd(link, nodeId);
    const endpoint = describeEndpoint(index, other, titleOf);
    if (!endpoint) continue;
    const title = endpointTitle(endpoint);
    const crumbs = endpointCrumbs(endpoint);
    out.push({
      link,
      nodeId: other,
      endpoint,
      title,
      crumbs,
      tooltip: [crumbs, title, link.note].filter((x): x is string => !!x).join('\n'),
    });
  }
  return out;
}

/** The default toggle text of RelatedLinks ("2 related"). */
export function relatedLabel(count: number): string {
  return `${count} related`;
}

/** What a picker for links from `sourceNodeId` must not offer: the node itself and its linked nodes. */
export function linkExclusions(linksByNode: LinksByNode, sourceNodeId: string | null): Set<string> {
  const out = new Set<string>();
  if (sourceNodeId === null) return out;
  out.add(sourceNodeId);
  for (const link of linksByNode.get(sourceNodeId) ?? []) out.add(otherEnd(link, sourceNodeId));
  return out;
}

/** One row of the picker's list. */
export interface PickerRow {
  /** Unique within the list (the option's DOM id ends with it). */
  key: string;
  /** A branch (a heading while browsing; a tangent whose title matched in search) or a message. */
  kind: 'branch' | 'message';
  /** What picking the row links to (a tangent: its first message); null for a heading that can't be picked. */
  nodeId: string | null;
  /** The branch's title, or the message's snippet. */
  title: string;
  /** Search results: where the message lives. Empty while browsing (the headings say it). */
  crumbs: string;
  /** Outline depth while browsing (0 = main thread); 0 in search results. */
  depth: number;
  /** A message's role; null for a branch. */
  role: Role | null;
}

export interface PickerRowOptions {
  /** Nodes never offered (see `linkExclusions`). */
  exclude?: ReadonlySet<string>;
  titleOf?: BranchTitleOf;
  /** Most search results (default PICKER_SEARCH_LIMIT). Browsing lists everything. */
  limit?: number;
}

/** The picker's list: search results for a query, else the whole outline to browse. */
export function pickerRows(
  index: TreeIndex,
  query: string,
  options: PickerRowOptions = {},
): PickerRow[] {
  return query.trim() === '' ? browseRows(index, options) : searchRows(index, query, options);
}

/**
 * The outline, trunk first, each branch a heading followed by its messages.
 * A tangent's heading picks its first message (which isn't listed again);
 * the trunk's heading picks nothing. Excluded messages are left out, and so
 * is a heading with nothing under it to pick.
 */
export function browseRows(index: TreeIndex, options: PickerRowOptions = {}): PickerRow[] {
  const exclude = options.exclude ?? new Set<string>();
  const titleOf = options.titleOf ?? ownTitle;
  const rows: PickerRow[] = [];
  for (const item of flattenOutline(buildOutline(index))) {
    const { branch, depth } = item;
    const nodes = index.nodesByBranch.get(branch.id) ?? [];
    const isTangent = branch.parentBranchId !== null;
    const head = isTangent ? nodes[0] : undefined;
    const headId = head && !exclude.has(head.id) ? head.id : null;
    const messages: PickerRow[] = [];
    for (const node of isTangent ? nodes.slice(1) : nodes) {
      if (exclude.has(node.id)) continue;
      messages.push({
        key: `n-${node.id}`,
        kind: 'message',
        nodeId: node.id,
        title: snippetOf(index, node.id, titleOf),
        crumbs: '',
        depth,
        role: node.role,
      });
    }
    if (headId === null && messages.length === 0) continue;
    rows.push({
      key: `b-${branch.id}`,
      kind: 'branch',
      nodeId: headId,
      title: titleOf(branch),
      crumbs: '',
      depth,
      role: null,
    });
    rows.push(...messages);
  }
  return rows;
}

/** `searchNodes` as picker rows: a tangent whose title matched is a branch row, the rest messages. */
export function searchRows(
  index: TreeIndex,
  query: string,
  options: PickerRowOptions = {},
): PickerRow[] {
  const titleOf = options.titleOf ?? ownTitle;
  const hits = searchNodes(index, query, {
    exclude: options.exclude,
    limit: options.limit ?? PICKER_SEARCH_LIMIT,
    titleOf,
  });
  const rows: PickerRow[] = [];
  for (const hit of hits) {
    const endpoint = describeEndpoint(index, hit.node.id, titleOf);
    if (!endpoint) continue;
    rows.push({
      key: `n-${hit.node.id}`,
      kind: hit.titleHit ? 'branch' : 'message',
      nodeId: hit.node.id,
      title: hit.titleHit ? titleOf(hit.branch) : endpoint.snippet || 'Empty message',
      crumbs: endpointCrumbs(endpoint, hit.titleHit),
      depth: 0,
      role: hit.titleHit ? null : hit.node.role,
    });
  }
  return rows;
}

/** The first row that can be picked; -1 when none can. */
export function firstPickable(rows: readonly PickerRow[]): number {
  return rows.findIndex((r) => r.nodeId !== null);
}

/**
 * The next pickable row from `from` in direction `step` (arrow keys),
 * skipping headings; stays put at either end. From -1 it starts at the
 * first pickable row.
 */
export function movePick(rows: readonly PickerRow[], from: number, step: 1 | -1): number {
  if (from < 0 || from >= rows.length) return firstPickable(rows);
  for (let i = from + step; i >= 0 && i < rows.length; i += step) {
    const row = rows[i];
    if (row && row.nodeId !== null) return i;
  }
  return from;
}

/**
 * The highlighted row after the list changed under it: the same message if
 * it is still listed (the tree changed while browsing), else the first
 * pickable row. A new query always starts from the top.
 */
export function followActive(
  previous: { rows: readonly PickerRow[]; query: string; active: number } | undefined,
  rows: readonly PickerRow[],
  query: string,
): number {
  if (previous === undefined || previous.query !== query) return firstPickable(rows);
  const key = previous.rows[previous.active]?.key;
  const kept = key === undefined ? -1 : rows.findIndex((r) => r.key === key && r.nodeId !== null);
  return kept >= 0 ? kept : firstPickable(rows);
}

function snippetOf(index: TreeIndex, nodeId: string, titleOf: BranchTitleOf): string {
  return describeEndpoint(index, nodeId, titleOf)?.snippet || 'Empty message';
}
