import type { TreeIndex } from '@tangent/core';
import type { ShareSummary } from '@tangent/shared';

export const SCOPE_LABEL: Record<ShareSummary['scope'], string> = {
  tree: 'Whole conversation',
  subtree: 'Subtree',
  path: 'Path',
};

/**
 * The shares of one conversation, in the list's order (newest first). The list
 * endpoint returns every share of the account, each with its `treeId`, so the
 * share dialog filters here rather than asking the server for less.
 */
export function sharesOfTree(shares: readonly ShareSummary[], treeId: string): ShareSummary[] {
  return shares.filter((s) => s.treeId === treeId);
}

/**
 * Title of the branch a subtree or path share starts from (subtree) or ends in
 * (path): the branch of its target message. Null for a whole-conversation share,
 * or when the message isn't in `index` (another conversation, or since deleted).
 */
export function shareBranchTitle(share: ShareSummary, index: TreeIndex | null): string | null {
  if (share.scope === 'tree' || !share.targetNodeId || !index) return null;
  const node = index.nodes.get(share.targetNodeId);
  return (node && index.branches.get(node.branchId)?.title) || null;
}
