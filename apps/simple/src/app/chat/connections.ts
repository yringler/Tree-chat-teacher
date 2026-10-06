import type { Branch } from '@tangent/shared';
import type { RelatedLink } from '@tangent/web-shared';
import { branchTitle } from './titles';

/*
 * Learn's words for links between messages ("connections"). The shared chips
 * and picker name things in power-mode terms ("2 related", "Tangent: …");
 * a learner connects messages of a lesson and its side questions.
 */

/** The main thread, as Learn's breadcrumbs name it. */
export const LESSON_CRUMB = 'Lesson';

/** A branch as the connection chips and the picker name it: "Lesson" or the side question's title. */
export function connectionTitleOf(branch: Branch): string {
  return branch.parentBranchId === null ? LESSON_CRUMB : branchTitle(branch);
}

/** The label above a message's connection chips. */
export function connectedLabel(count: number): string {
  return count === 1 ? 'Connected to 1 message' : `Connected to ${count} messages`;
}

/**
 * The chips as Learn shows them: a side question's first message is the side
 * question itself ("Side question: ‹title›", like the fork dividers), not a
 * tangent; everything else is as resolved.
 */
export function learnConnections(entries: readonly RelatedLink[]): RelatedLink[] {
  return entries.map((e) => {
    if (!e.endpoint.isTangentHead) return e;
    const title = `Side question: ${e.endpoint.crumbs.at(-1) ?? connectionTitleOf(e.endpoint.branch)}`;
    return {
      ...e,
      title,
      tooltip: [e.crumbs, title, e.link.note].filter((x): x is string => !!x).join('\n'),
    };
  });
}
