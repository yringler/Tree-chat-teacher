import { deleteBranchQuestion } from '@tangent/web-shared';
import type { CanvasStore } from '../state/canvas-store';
import { laneTitle } from './titles';

/**
 * Asks, then deletes a lane with every lane below it. Shared by the lane
 * head and the lane settings dialog. Resolves true if it was deleted.
 */
export async function confirmDeleteLane(store: CanvasStore, branchId: string): Promise<boolean> {
  const idx = store.index();
  const branch = idx?.branches.get(branchId);
  const question =
    idx && branch
      ? deleteBranchQuestion(idx, branchId, {
          title: laneTitle(branch),
          noun: { one: 'lane', many: 'lanes' },
          consequences:
            'Replies still being written there are stopped, and shares of its messages stop working.',
        })
      : null;
  if (!question || !confirm(question)) return false;
  return store.deleteBranch(branchId);
}
