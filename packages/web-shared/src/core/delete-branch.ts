import type { TreeIndex } from '@tangent/core/tree';

/** What an app calls a branch: "branch" in power, "side question" in Learn, "lane" on the canvas. */
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
