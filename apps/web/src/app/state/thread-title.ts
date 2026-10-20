import { TRUNK_TITLE, type Branch } from '@tangent/shared';

/**
 * A branch's title as power shows it: the main thread is always called
 * that, as in Learn, whatever title it has stored; a tangent has its own.
 */
export function threadTitle(branch: Pick<Branch, 'parentBranchId' | 'title'>): string {
  return branch.parentBranchId === null ? TRUNK_TITLE : branch.title;
}
