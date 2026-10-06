import { deleteBranchQuestion } from '@tangent/web-shared';
import type { LessonStore } from '../state/lesson-store';
import { branchTitle } from './titles';

/**
 * Asks, then deletes a side question with every side question below it.
 * Shared by the lesson header (the open side question) and each message's
 * side-question chips. Resolves true if it was deleted.
 */
export async function confirmDeleteSideQuestion(
  store: LessonStore,
  branchId: string,
): Promise<boolean> {
  const idx = store.index();
  const branch = idx?.branches.get(branchId);
  const question =
    idx && branch
      ? deleteBranchQuestion(idx, branchId, {
          title: branchTitle(branch),
          noun: { one: 'side question', many: 'side questions' },
          consequences: 'Replies still being written there are stopped.',
        })
      : null;
  if (!question || !confirm(question)) return false;
  return store.deleteSideQuestion(branchId);
}
