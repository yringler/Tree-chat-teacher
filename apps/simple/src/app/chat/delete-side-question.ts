import { deleteBranchQuestion } from '@tangent/web-shared';
import type { LessonStore } from '../state/lesson-store';
import { branchTitle } from './titles';

/**
 * Asks, then deletes a tangent with every tangent below it.
 * Shared by the lesson header (the open tangent) and each message's
 * tangent chips. Resolves true if it was deleted.
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
          noun: { one: 'tangent', many: 'tangents' },
          consequences: 'Replies still being written there are stopped.',
        })
      : null;
  if (!question || !confirm(question)) return false;
  return store.deleteSideQuestion(branchId);
}
