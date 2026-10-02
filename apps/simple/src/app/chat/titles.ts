import { DEFAULT_BRANCH_TITLE_PREFIX, DEFAULT_TREE_TITLE, type Branch } from '@tangent/shared';

/*
 * The Learn app's words for the core's default titles. The ChatService names
 * things in power-mode terms ("New conversation", "Main thread", "Branch: …");
 * a learner sees lessons and side questions.
 */

/** A lesson's title until the tutor's first reply names it. */
export const NEW_LESSON_TITLE = 'New lesson';

/** A lesson's title as shown to the learner. */
export function lessonTitle(title: string): string {
  return title === DEFAULT_TREE_TITLE ? NEW_LESSON_TITLE : title;
}

/**
 * A side question's title as shown to the learner. A side question started
 * from a whole message is named "Branch: <its first words>" until the first
 * reply renames it; here it is already labelled a side question, so the
 * prefix goes.
 */
export function branchTitle(branch: Pick<Branch, 'title' | 'titleSource'>): string {
  const { title, titleSource } = branch;
  if (titleSource === 'default' && title.startsWith(DEFAULT_BRANCH_TITLE_PREFIX)) {
    return title.slice(DEFAULT_BRANCH_TITLE_PREFIX.length);
  }
  return title;
}
