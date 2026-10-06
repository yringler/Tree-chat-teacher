import {
  citationDomain,
  isCitableUrl,
  splitTangents,
  tangentsAsMarkdown,
  type ShareBranch,
  type ShareMessage,
  type SharePayload,
  type ShareSource,
} from '@tangent/shared';

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

/** Text of a Markdown link: no brackets or newlines that would break it. */
function linkText(text: string): string {
  return text
    .replace(/[[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A "Sources" list of a grounded reply (http(s) links only), or '' without sources. */
export function sourcesMarkdown(sources: readonly ShareSource[] | undefined): string {
  const items = (sources ?? [])
    .filter((s) => isCitableUrl(s.url))
    .map((s) => {
      // Parentheses and spaces would end the link destination early.
      const url = s.url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      return `- [${linkText(s.title ?? '') || citationDomain(s.url)}](${url})`;
    });
  return items.length === 0 ? '' : `**Sources**\n\n${items.join('\n')}`;
}

/**
 * A message as shared or exported: an assistant reply's `<tangents>` block
 * becomes a plain "Where next?" list (there are no buttons to follow it),
 * and a grounded reply ends with its "Sources".
 */
export function messageMarkdown(m: ShareMessage): string {
  if (m.role !== 'assistant') return m.content;
  const body = tangentsAsMarkdown(m.content);
  const sources = sourcesMarkdown(m.sources);
  return sources === '' ? body : `${body}\n\n${sources}`;
}

function renderMessages(messages: readonly ShareMessage[]): string[] {
  return messages.map(
    (m) => `**${m.role === 'user' ? 'User' : 'Assistant'}:**\n\n${messageMarkdown(m)}`,
  );
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
 * "**User:**" / "**Assistant:**" blocks. Message content is emitted verbatim,
 * except that a reply's `<tangents>` block becomes a "Where next?" list.
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
      blocks.push(`Forked from: “${excerpt(splitTangents(fork.content).body)}”`);
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
