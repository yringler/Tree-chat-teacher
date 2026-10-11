import type { ShareMessage, SharePayload } from '@tangent/shared';

/**
 * Every text a share page shows, for screening: the title, the context
 * above a subtree, each branch's title and quoted anchor, and every message,
 * the user's and the AI's alike, with its sources' titles. The AI's replies
 * are screened too: whoever publishes them is who hosts them.
 */
export function shareTexts(payload: SharePayload): string[] {
  const messageTexts = (m: ShareMessage) => [
    m.content,
    ...(m.sources ?? []).flatMap((s) => (s.title ? [s.title] : [])),
  ];
  return [
    payload.title,
    ...(payload.context ?? []).flatMap(messageTexts),
    ...payload.branches.flatMap((b) => [
      b.title,
      ...(b.anchorQuote ? [b.anchorQuote] : []),
      ...b.messages.flatMap(messageTexts),
    ]),
  ];
}
