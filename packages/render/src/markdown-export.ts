import type { SharePayload } from '@tangent/shared';

/**
 * Markdown export of a payload: title, optional collapsed ancestor context
 * (<details>), then branches depth-first. Each branch gets a heading with its
 * breadcrumb (e.g. "Trunk › Side topic"), a "Forked from: …" line quoting the
 * fork message excerpt, an optional anchor-quote blockquote, then messages as
 * "**User:**" / "**Assistant:**" blocks. Message content is emitted verbatim.
 */
export function payloadToMarkdown(payload: SharePayload): string {
  void payload;
  throw new Error('not implemented');
}
