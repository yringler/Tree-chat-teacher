/*
 * Suggested follow-ups: the offers a reply ends with, each either a next
 * step in the thread's topic ("continue") or a side trip ("tangent"). The
 * default prompt (DEFAULT_SYSTEM_PROMPT, ./default-prompt.ts) asks for them
 * in a fixed block with a kind tag on each line,
 *
 *   <tangents>
 *   - [continue] Title — why it's the next step
 *   - [tangent] Title — why it's worth following
 *   </tangents>
 *
 * which the apps turn into "Keep going" and "Suggested tangents" buttons
 * (under the reply's "Your tangents") and keep out of the rendered reply;
 * shares and exports show "Keep going" and "Tangents" as plain lists. The
 * block stays in the stored message (and so in later context), so the model
 * sees what it already offered. The tag lives in the text rather than in a
 * provider's structured output, so it streams through every provider the
 * same way; apps/flutter/lib/api/tangents.dart mirrors this parser.
 */

export const TANGENTS_TAG = 'tangents';
export const TANGENTS_OPEN = `<${TANGENTS_TAG}>`;
export const TANGENTS_CLOSE = `</${TANGENTS_TAG}>`;

/**
 * What following a suggestion does. `continue` advances the thread's main
 * topic to its next step, so it is sent as a reply; `tangent` clarifies
 * something in the reply or explores a side topic, so it opens a tangent.
 */
export type TangentKind = 'continue' | 'tangent';

export interface Tangent {
  /** Short, specific title; also the message sent when it is followed. */
  title: string;
  /** The half-sentence on why it is worth following, or null when the line had none. */
  why: string | null;
  kind: TangentKind;
}

/** The heading over the `continue` suggestions. */
export const KEEP_GOING_LABEL = 'Keep going';
/** The heading over the `tangent` suggestions in shares and exports. */
export const TANGENTS_LABEL = 'Tangents';
/** The heading over the tangents started from a reply, in the apps. */
export const YOUR_TANGENTS_LABEL = 'Your tangents';
/** The heading over the `tangent` suggestions no tangent follows yet, in the apps. */
export const SUGGESTED_TANGENTS_LABEL = 'Suggested tangents';

export interface SplitTangents {
  /** The reply without its tangents block (trailing whitespace trimmed). */
  body: string;
  tangents: Tangent[];
  /** True while a block is open but not yet closed (the reply is still streaming). */
  partial: boolean;
}

const OPEN_RE = /<tangents\s*>/i;
const CLOSE_RE = /<\/tangents\s*>/i;
/** List marker: "- ", "* ", "• ", "1. ", "1) ". */
const MARKER_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;
/** Title / reason separator: a spaced em or en dash, a spaced hyphen, or a colon followed by a space. */
const SEPARATOR_RE = /\s+[—–-]\s+|\s*—\s*|:\s+/;
/** Kind tag; [next] and [reply] are taken as continue because models paraphrase the tag. */
const KIND_RE = /^\[(continue|next|reply|tangent)\]\s*/i;
const MAX_CONTINUE = 3;
const MAX_TANGENTS = 6;
const MAX_TITLE_CHARS = 200;

function unwrap(text: string): string {
  return text
    .trim()
    .replace(/^\*\*(.+)\*\*$/s, '$1')
    .replace(/^__(.+)__$/s, '$1')
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strips a leading kind tag; null when there is none. */
function takeKind(text: string): { kind: TangentKind; rest: string } | null {
  const m = KIND_RE.exec(text);
  if (!m) return null;
  const tag = (m[1] ?? '').toLowerCase();
  return { kind: tag === 'tangent' ? 'tangent' : 'continue', rest: text.slice(m[0].length) };
}

/**
 * One line of the block → a suggestion, or null for blank or marker-only
 * lines. The tag may sit outside or inside bold (`[continue] **X**`,
 * `**[continue] X**`). A line without a tag is a tangent: operators'
 * LEARN_SYSTEM_PROMPT and POOL_SYSTEM_PROMPT, saved custom prompts and power
 * trees on the prompt they began with may not ask for tags, and models
 * sometimes drop them; a side trip is the safe reading of an unknown offer.
 */
export function parseTangentLine(line: string): Tangent | null {
  let text = line.replace(MARKER_RE, '').trim();
  const outer = takeKind(text);
  if (outer) text = outer.rest.trim();
  if (text === '') return null;
  const sep = SEPARATOR_RE.exec(text);
  const rawTitle = sep ? text.slice(0, sep.index) : text;
  const rawWhy = sep ? text.slice(sep.index + sep[0].length) : '';
  let title = unwrap(rawTitle);
  const inner = outer ? null : takeKind(title);
  if (inner) title = unwrap(inner.rest);
  title = title.replace(/[.;,]+$/, '');
  if (title === '') return null;
  const why = unwrap(rawWhy);
  return {
    title: title.slice(0, MAX_TITLE_CHARS),
    why: why === '' ? null : why,
    kind: outer?.kind ?? inner?.kind ?? 'tangent',
  };
}

/**
 * Separates a reply from its tangents block. A reply without one comes back
 * unchanged with no tangents. While the block is still open (streaming), the
 * body stops at the opening tag so the raw block never shows, and `partial`
 * is true. Text after the closing tag is kept in the body.
 */
export function splitTangents(content: string): SplitTangents {
  const open = OPEN_RE.exec(content);
  if (!open) return { body: content.trimEnd(), tangents: [], partial: false };
  const before = content.slice(0, open.index);
  const rest = content.slice(open.index + open[0].length);
  const close = CLOSE_RE.exec(rest);
  if (!close) return { body: before.trimEnd(), tangents: [], partial: true };
  const inside = rest.slice(0, close.index);
  const after = rest.slice(close.index + close[0].length);
  const tangents: Tangent[] = [];
  // Keyed across both kinds: a title offered twice keeps its first kind.
  const seen = new Set<string>();
  const count: Record<TangentKind, number> = { continue: 0, tangent: 0 };
  for (const line of inside.split(/\r?\n/)) {
    const t = parseTangentLine(line);
    if (!t) continue;
    const key = t.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (count[t.kind] >= (t.kind === 'continue' ? MAX_CONTINUE : MAX_TANGENTS)) continue;
    count[t.kind]++;
    tangents.push(t);
  }
  const body = after.trim() === '' ? before.trimEnd() : `${before.trimEnd()}\n\n${after.trim()}`;
  return { body, tangents, partial: false };
}

/** Renders suggestions in the block format the prompt asks for (used by the demo). */
export function formatTangents(tangents: readonly Tangent[]): string {
  const lines = tangents.map((t) =>
    t.why ? `- [${t.kind}] ${t.title} — ${t.why}` : `- [${t.kind}] ${t.title}`,
  );
  return `${TANGENTS_OPEN}\n${lines.join('\n')}\n${TANGENTS_CLOSE}`;
}

/** The suggestions split by kind, each group in its original order. */
export function groupTangents(tangents: readonly Tangent[]): {
  continue: Tangent[];
  tangent: Tangent[];
} {
  return {
    continue: tangents.filter((t) => t.kind === 'continue'),
    tangent: tangents.filter((t) => t.kind === 'tangent'),
  };
}

/** What a finished reply's tangents footer shows, in every app. */
export interface TangentFooter<B> {
  /** The tangents started from the reply, in the order given: shown first. */
  yours: B[];
  /** The `tangent` suggestions no tangent follows yet, in their order. */
  offers: Tangent[];
  /** The offers start hidden behind one row (`suggestedFoldLabel`). */
  folded: boolean;
  /** How many `tangent` suggestions a tangent follows. */
  followed: number;
}

/**
 * Sorts a reply's tangents footer by where the user went, not by where an
 * idea came from. Every tangent started from the reply is the user's,
 * whether it follows a suggestion or was asked in their own words; one that
 * carries a suggestion's title follows it, so that suggestion leaves the
 * offers rather than showing twice. Once the reply has a tangent of the
 * user's, its offers fold: the user has read them (they picked from them),
 * and a reply's footer then changes only when the user starts a tangent
 * (and moves to it) or deletes one, never while they read or a reply streams
 * in.
 */
export function tangentFooter<B extends { readonly title: string }>(
  tangents: readonly Tangent[],
  children: readonly B[],
): TangentFooter<B> {
  const taken = new Set(children.map((b) => b.title));
  const suggested = groupTangents(tangents).tangent;
  const offers = suggested.filter((t) => !taken.has(t.title));
  return {
    yours: [...children],
    offers,
    folded: children.length > 0 && offers.length > 0,
    followed: suggested.length - offers.length,
  };
}

/**
 * The row folded suggestions hide behind: "4 suggested tangents", or
 * "3 more suggested" when one is already in view or followed (`more`).
 */
export function suggestedFoldLabel(hidden: number, more: boolean): string {
  if (more) return `${hidden} more suggested`;
  return hidden === 1 ? '1 suggested tangent' : `${hidden} suggested tangents`;
}

function markdownList(label: string, tangents: readonly Tangent[]): string {
  const items = tangents.map((t) => (t.why ? `- **${t.title}** — ${t.why}` : `- **${t.title}**`));
  return `**${label}**\n\n${items.join('\n')}`;
}

/**
 * A reply with its suggestions block rewritten as plain Markdown "Keep going"
 * and "Tangents" lists (shares and exports, which have no buttons), leaving
 * out an empty group. A reply without a block comes back unchanged; a
 * half-written block is dropped.
 */
export function tangentsAsMarkdown(content: string): string {
  if (!OPEN_RE.test(content)) return content;
  const { body, tangents } = splitTangents(content);
  const groups = groupTangents(tangents);
  const lists = [
    groups.continue.length > 0 ? markdownList(KEEP_GOING_LABEL, groups.continue) : '',
    groups.tangent.length > 0 ? markdownList(TANGENTS_LABEL, groups.tangent) : '',
  ].filter((l) => l !== '');
  if (lists.length === 0) return body;
  const list = lists.join('\n\n');
  return body === '' ? list : `${body}\n\n${list}`;
}
