import type {
  Branch,
  ChatNode,
  ShareBranch,
  ShareMessage,
  SharePayload,
  ShareScope,
  Tree,
} from '@tangent/shared';
import { indexTree, isEffectivelyPrivate, pathToNode, type TreeIndex } from './tree.js';

export interface ProjectShareInput {
  tree: Pick<Tree, 'title'>;
  branches: readonly Branch[];
  nodes: readonly ChatNode[];
  scope: ShareScope;
  /** Required for subtree/path. */
  targetNodeId: string | null;
  /** subtree only. */
  includeAncestors: boolean;
  title: string | null;
  /** ISO timestamp stored as `generatedAt`. */
  now: string;
  /** Owner exports may opt in; shares never do. Default false. */
  includePrivate?: boolean;
}

export type ProjectShareResult =
  | { ok: true; payload: SharePayload }
  | { ok: false; reason: 'target_not_found' | 'target_private' | 'empty' };

/** Max length of `SharePayload.description`. */
export const SHARE_DESCRIPTION_MAX = 200;

/** Intermediate branch before keys are assigned. */
interface DraftBranch {
  /** Internal id of the fork node (in the parent draft); null for the root. */
  forkNodeId: string | null;
  title: string;
  anchorQuote: string | null;
  nodes: ChatNode[];
  children: DraftBranch[];
}

function isVisible(node: ChatNode): boolean {
  return (node.role === 'user' || node.role === 'assistant') && node.status === 'complete';
}

/**
 * Builds the public payload from an allow-list of fields. Rules:
 * - only `user`/`assistant` nodes with status `complete` are included;
 * - private branches and all their descendants are omitted entirely; a target
 *   inside a private branch yields `target_private`;
 * - `tree`: every branch, rooted at the trunk;
 * - `subtree`: the target node's branch from the target onward is the root
 *   branch, plus every branch hanging off any included node, recursively;
 *   `includeAncestors` puts root → target's parent in `context`;
 * - `path`: one branch holding root → target, no other branches;
 * - keys are `b<n>`/`m<n>` in depth-first order; no internal ids leak;
 * - description: first user message as plain text, <= 200 chars.
 *
 * Choices:
 * - A child branch whose fork node is not itself included (a system,
 *   streaming or errored node, or a node before the subtree target) is
 *   omitted together with all its descendants: it would have nothing to hang
 *   off in the payload.
 * - Branches left with no messages are still included (they show as empty).
 * - For `tree` scope, a private trunk yields `target_private`.
 * - Context messages are keyed first (`m0`…), then branch messages.
 * - `context` is null when it would be empty.
 * - `empty` means no message anywhere in the result (context included).
 * - Description falls back to the first message of any role, then "".
 */
export function projectShare(input: ProjectShareInput): ProjectShareResult {
  const index = indexTree(input.branches, input.nodes);
  const includePrivate = input.includePrivate === true;
  const allowed = (branchId: string): boolean =>
    includePrivate || !isEffectivelyPrivate(index, branchId);

  let root: DraftBranch;
  let context: ChatNode[] | null = null;
  let title: string;

  if (input.scope === 'tree') {
    if (!allowed(index.trunk.id)) return { ok: false, reason: 'target_private' };
    root = draftSubtree(index, index.trunk, 0, true, allowed);
    title = input.tree.title;
  } else {
    const target = input.targetNodeId === null ? undefined : index.nodes.get(input.targetNodeId);
    const branch = target === undefined ? undefined : index.branches.get(target.branchId);
    if (target === undefined || branch === undefined)
      return { ok: false, reason: 'target_not_found' };
    if (!allowed(branch.id)) return { ok: false, reason: 'target_private' };
    title =
      branch.id === index.trunk.id ? input.tree.title : `${input.tree.title} — ${branch.title}`;

    if (input.scope === 'subtree') {
      root = draftSubtree(index, branch, target.seq, true, allowed);
      if (target.seq !== 0) root.anchorQuote = null;
      if (input.includeAncestors) {
        const ancestors = pathToNode(index, target.id).slice(0, -1).filter(isVisible);
        context = ancestors.length > 0 ? ancestors : null;
      }
    } else {
      root = {
        forkNodeId: null,
        title: branch.title,
        anchorQuote: null,
        nodes: pathToNode(index, target.id).filter(isVisible),
        children: [],
      };
    }
  }
  if (input.title !== null && input.title.trim() !== '') title = input.title;

  // Assign keys depth-first.
  let messageCounter = 0;
  const toMessage = (node: ChatNode): ShareMessage => ({
    key: `m${messageCounter++}`,
    // isVisible guarantees user/assistant.
    role: node.role === 'user' ? 'user' : 'assistant',
    content: node.content,
  });
  const contextMessages = context === null ? null : context.map(toMessage);

  const out: ShareBranch[] = [];
  const walk = (
    draft: DraftBranch,
    parentKey: string | null,
    parentMessageKeys: ReadonlyMap<string, string>,
  ): void => {
    const key = `b${out.length}`;
    const forkMessageKey =
      draft.forkNodeId === null ? null : (parentMessageKeys.get(draft.forkNodeId) ?? null);
    const messages: ShareMessage[] = [];
    const keysById = new Map<string, string>();
    for (const node of draft.nodes) {
      const m = toMessage(node);
      keysById.set(node.id, m.key);
      messages.push(m);
    }
    out.push({
      key,
      parentKey,
      forkMessageKey,
      title: draft.title,
      anchorQuote: draft.anchorQuote,
      messages,
    });
    for (const child of draft.children) walk(child, key, keysById);
  };
  walk(root, null, new Map());

  const allMessages = [...(contextMessages ?? []), ...out.flatMap((b) => b.messages)];
  if (allMessages.length === 0) return { ok: false, reason: 'empty' };

  const branchMessages = out.flatMap((b) => b.messages);
  const first = branchMessages.find((m) => m.role === 'user') ?? branchMessages[0];

  const rootBranch = out[0];
  if (rootBranch === undefined) return { ok: false, reason: 'empty' };
  return {
    ok: true,
    payload: {
      v: 1,
      title,
      description:
        first === undefined ? '' : plainTextExcerpt(first.content, SHARE_DESCRIPTION_MAX),
      scope: input.scope,
      generatedAt: input.now,
      context: contextMessages,
      rootBranchKey: rootBranch.key,
      branches: out,
    },
  };
}

/**
 * Draft for `branch` starting at `fromSeq`, plus every allowed child branch
 * hanging off one of its included nodes, recursively (outline order).
 */
function draftSubtree(
  index: TreeIndex,
  branch: Branch,
  fromSeq: number,
  isRoot: boolean,
  allowed: (branchId: string) => boolean,
): DraftBranch {
  const nodes = (index.nodesByBranch.get(branch.id) ?? []).filter(
    (n) => n.seq >= fromSeq && isVisible(n),
  );
  const draft: DraftBranch = {
    forkNodeId: isRoot ? null : branch.branchPointNodeId,
    title: branch.title,
    anchorQuote: branch.anchorQuote,
    nodes,
    children: [],
  };
  const included = new Set(nodes.map((n) => n.id));
  for (const child of index.childBranches.get(branch.id) ?? []) {
    if (child.branchPointNodeId === null || !included.has(child.branchPointNodeId)) continue;
    if (!allowed(child.id)) continue;
    draft.children.push(draftSubtree(index, child, 0, false, allowed));
  }
  return draft;
}

/**
 * Markdown → single-line plain text: drops code-fence markers, heading /
 * quote / list markers, emphasis and inline-code characters; links and images
 * become their text; whitespace is collapsed. Truncated to `max` chars
 * (including a trailing ellipsis when cut).
 */
export function plainTextExcerpt(markdown: string, max: number): string {
  let text = markdown
    .replace(/^[ \t]*(```|~~~)[^\n]*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]*)>/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/gm, '')
    .replace(/[*`]+/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+/gu, '$1')
    .replace(/_+(?=[^\p{L}\p{N}]|$)/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > max) {
    const chars = Array.from(text);
    if (chars.length > max)
      text =
        chars
          .slice(0, Math.max(0, max - 1))
          .join('')
          .trimEnd() + '…';
  }
  return text;
}
