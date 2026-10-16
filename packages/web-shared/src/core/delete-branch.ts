import type { TreeIndex } from '@tangent/core/tree';
import type { Branch } from '@tangent/shared';

/** What an app calls a branch: "tangent" in power and Learn, "lane" on the canvas. */
export interface BranchNoun {
  one: string;
  many: string;
}

/** A branch with everything below it: how many branches, and their messages. */
export function subtreeSize(
  idx: TreeIndex,
  branchId: string,
): { branches: number; messages: number } {
  const root = idx.branches.get(branchId);
  if (!root) return { branches: 0, messages: 0 };
  let branches = 0;
  let messages = 0;
  const seen = new Set<string>();
  const stack = [root];
  for (let b = stack.pop(); b; b = stack.pop()) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    branches++;
    messages += idx.nodesByBranch.get(b.id)?.length ?? 0;
    stack.push(...(idx.childBranches.get(b.id) ?? []));
  }
  return { branches, messages };
}

/**
 * The question asked before deleting a branch with everything below it, in
 * the app's words: what goes (the branches below and the messages), what
 * else stops (`consequences`), and that it cannot be undone. Null for the
 * trunk or an unknown branch, which can't be deleted.
 */
export function deleteBranchQuestion(
  idx: TreeIndex,
  branchId: string,
  opts: { title: string; noun: BranchNoun; consequences: string },
): string | null {
  const branch = idx.branches.get(branchId);
  if (!branch?.parentBranchId) return null;
  const { branches, messages } = subtreeSize(idx, branchId);
  const counted = `${messages} message${messages === 1 ? '' : 's'}`;
  const below = branches - 1;
  const what =
    below > 0
      ? `“${opts.title}” and the ${below} ${below === 1 ? opts.noun.one : opts.noun.many} below it (${counted})`
      : `“${opts.title}” (${counted})`;
  return `Delete ${what}? ${opts.consequences} This cannot be undone.`;
}

const messagesCount = (n: number) => `${n} message${n === 1 ? '' : 's'}`;

/**
 * The question asked before deleting one of the user's messages, which takes
 * everything after it in its branch: the later messages, and the branches
 * started from them with everything below. The first message of a branch
 * takes the branch (`title` names it). Null for a reply or an unknown
 * message, which can't be deleted.
 */
export function deleteMessageQuestion(
  idx: TreeIndex,
  nodeId: string,
  opts: { title: (branch: Branch) => string; noun: BranchNoun; consequences: string },
): string | null {
  const node = idx.nodes.get(nodeId);
  const branch = node && idx.branches.get(node.branchId);
  if (!node || !branch || node.role !== 'user') return null;
  const tail = `${opts.consequences} This cannot be undone.`;
  if (node.seq === 0 && branch.parentBranchId) {
    const { branches, messages } = subtreeSize(idx, branch.id);
    const below = branches - 1;
    const along =
      below > 0
        ? ` along with the ${below} ${below === 1 ? opts.noun.one : opts.noun.many} below it`
        : '';
    return `Delete this message? It starts the ${opts.noun.one} “${opts.title(branch)}”, which goes with it${along} (${messagesCount(messages)}). ${tail}`;
  }
  const cut = (idx.nodesByBranch.get(branch.id) ?? []).filter((n) => n.seq >= node.seq);
  let branches = 0;
  let branchMessages = 0;
  for (const n of cut) {
    for (const b of idx.branchesAtNode.get(n.id) ?? []) {
      const size = subtreeSize(idx, b.id);
      branches += size.branches;
      branchMessages += size.messages;
    }
  }
  const later = cut.length - 1;
  const parts = [
    ...(later > 0 ? [`${later} later message${later === 1 ? '' : 's'}`] : []),
    ...(branches > 0
      ? [
          `${branches} ${branches === 1 ? opts.noun.one : opts.noun.many}` +
            (branchMessages > 0 ? ` (${messagesCount(branchMessages)})` : ''),
        ]
      : []),
  ];
  return parts.length > 0
    ? `Delete this message? Everything after it goes too: ${parts.join(' and ')}. ${tail}`
    : `Delete this message? ${tail}`;
}
