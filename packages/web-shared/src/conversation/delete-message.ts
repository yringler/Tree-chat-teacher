import type { TreeIndex } from '@tangent/core/tree';
import type { Branch } from '@tangent/shared';
import { deleteMessageQuestion, type BranchNoun } from '../core/delete-branch';

/**
 * Asks (`deleteMessageQuestion`, in the app's words), then deletes one of the
 * user's messages with everything after it. Resolves true if it was deleted.
 */
export async function confirmDeleteMessage(
  store: { index(): TreeIndex | null; deleteMessage(nodeId: string): Promise<boolean> },
  nodeId: string,
  words: { title: (branch: Branch) => string; noun: BranchNoun; consequences: string },
): Promise<boolean> {
  const idx = store.index();
  const question = idx ? deleteMessageQuestion(idx, nodeId, words) : null;
  if (!question || !confirm(question)) return false;
  return store.deleteMessage(nodeId);
}
