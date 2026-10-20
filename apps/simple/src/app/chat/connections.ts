import type { RelatedLink } from '@tangent/web-shared';
import { threadTitle } from './titles';

/*
 * Learn's words for links between messages ("connections"). The shared chips
 * and picker name things in power-mode terms ("2 related", "Tangent: …");
 * a learner connects messages of a lesson and its tangents.
 */

/** The label above a message's connection chips. */
export function connectedLabel(count: number): string {
  return count === 1 ? 'Connected to 1 message' : `Connected to ${count} messages`;
}

/**
 * The chips as Learn shows them: a tangent's first message is the tangent
 * itself ("Tangent: ‹title›", like the fork dividers); everything else is as
 * resolved.
 */
export function learnConnections(entries: readonly RelatedLink[]): RelatedLink[] {
  return entries.map((e) => {
    if (!e.endpoint.isTangentHead) return e;
    const title = `Tangent: ${e.endpoint.crumbs.at(-1) ?? threadTitle(e.endpoint.branch)}`;
    return {
      ...e,
      title,
      tooltip: [e.crumbs, title, e.link.note].filter((x): x is string => !!x).join('\n'),
    };
  });
}
