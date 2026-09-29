import type { ShareBranch, ShareMessage, SharePayload } from '@tangent/shared';

const EXCERPT_MAX = 80;

/** Single-line plain-text excerpt of markdown (for "Forked from" lines). */
function excerpt(markdown: string, max = EXCERPT_MAX): string {
  const text = markdown
    .replace(/^[ \t]*(```|~~~)[^\n]*$/gm, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/[*`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length > max
    ? chars
        .slice(0, max - 1)
        .join('')
        .trimEnd() + '…'
    : text;
}

function renderMessages(messages: readonly ShareMessage[]): string[] {
  return messages.map((m) => `**${m.role === 'user' ? 'User' : 'Assistant'}:**\n\n${m.content}`);
}

/** Collapse newlines so user-provided titles cannot break the heading. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Markdown export of a payload: title, optional collapsed ancestor context
 * (<details>), then branches depth-first. Each branch gets a heading with its
 * breadcrumb (e.g. "Trunk › Side topic"), a "Forked from: …" line quoting the
 * fork message excerpt, an optional anchor-quote blockquote, then messages as
 * "**User:**" / "**Assistant:**" blocks. Message content is emitted verbatim.
 */
export function payloadToMarkdown(payload: SharePayload): string {
  const byKey = new Map<string, ShareBranch>(payload.branches.map((b) => [b.key, b]));
  const messages = new Map<string, ShareMessage>();
  for (const b of payload.branches) for (const m of b.messages) messages.set(m.key, m);

  const breadcrumb = (branch: ShareBranch): string => {
    const titles: string[] = [];
    const seen = new Set<string>();
    let cur: ShareBranch | undefined = branch;
    while (cur !== undefined && !seen.has(cur.key)) {
      seen.add(cur.key);
      titles.unshift(oneLine(cur.title));
      cur = cur.parentKey === null ? undefined : byKey.get(cur.parentKey);
    }
    return titles.join(' › ');
  };

  const blocks: string[] = [`# ${oneLine(payload.title)}`];

  if (payload.context !== null && payload.context.length > 0) {
    blocks.push(
      [
        '<details>',
        '<summary>Earlier context</summary>',
        '',
        ...renderMessages(payload.context).flatMap((m) => [m, '']),
        '</details>',
      ]
        .join('\n')
        .trimEnd(),
    );
  }

  for (const branch of payload.branches) {
    blocks.push(`## ${breadcrumb(branch)}`);
    const fork = branch.forkMessageKey === null ? undefined : messages.get(branch.forkMessageKey);
    if (fork !== undefined) {
      blocks.push(`Forked from: “${excerpt(fork.content)}”`);
    }
    if (branch.anchorQuote !== null && branch.anchorQuote.trim() !== '') {
      blocks.push(
        branch.anchorQuote
          .trim()
          .split(/\r?\n/)
          .map((line) => (line === '' ? '>' : `> ${line}`))
          .join('\n'),
      );
    }
    if (branch.messages.length === 0) blocks.push('_(no messages)_');
    else blocks.push(...renderMessages(branch.messages));
  }

  return blocks.join('\n\n') + '\n';
}
