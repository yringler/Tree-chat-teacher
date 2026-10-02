import { DEFAULT_BRANCH_TITLE_PREFIX, DEFAULT_TREE_TITLE, type Branch } from '@tangent/shared';

/** A conversation's title until the first reply names it. */
export const NEW_TREE_TITLE = 'Untitled canvas';

export function treeTitle(title: string): string {
  return title === DEFAULT_TREE_TITLE ? NEW_TREE_TITLE : title;
}

/**
 * A lane's title. A branch started from a whole message is named
 * "Branch: <its first words>" until the first reply renames it; on the canvas
 * every column is visibly a lane, so the prefix goes.
 */
export function laneTitle(branch: Pick<Branch, 'title' | 'titleSource'>): string {
  const { title, titleSource } = branch;
  if (titleSource === 'default' && title.startsWith(DEFAULT_BRANCH_TITLE_PREFIX)) {
    return title.slice(DEFAULT_BRANCH_TITLE_PREFIX.length);
  }
  return title;
}
