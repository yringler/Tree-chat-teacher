/*
 * Tangents: the "where next?" offers a Learn reply ends with. The tutor
 * prompt (apps/worker/src/simple-mode.ts) asks for them in a fixed block,
 *
 *   <tangents>
 *   - Title — why it's worth following
 *   </tangents>
 *
 * which the Learn app turns into branch buttons and keeps out of the rendered
 * reply. The block stays in the stored message (and so in later context), so
 * the model sees what it already offered.
 */

export const TANGENTS_TAG = 'tangents';
export const TANGENTS_OPEN = `<${TANGENTS_TAG}>`;
export const TANGENTS_CLOSE = `</${TANGENTS_TAG}>`;

export interface Tangent {
  /** Short, specific title; also the first message of the branch that follows it. */
  title: string;
  /** The half-sentence on why it is worth following, or null when the line had none. */
  why: string | null;
}

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

/** One line of the block → a tangent, or null for blank or marker-only lines. */
export function parseTangentLine(line: string): Tangent | null {
  const text = line.replace(MARKER_RE, '').trim();
  if (text === '') return null;
  const sep = SEPARATOR_RE.exec(text);
  const rawTitle = sep ? text.slice(0, sep.index) : text;
  const rawWhy = sep ? text.slice(sep.index + sep[0].length) : '';
  const title = unwrap(rawTitle).replace(/[.;,]+$/, '');
  if (title === '') return null;
  const why = unwrap(rawWhy);
  return { title: title.slice(0, MAX_TITLE_CHARS), why: why === '' ? null : why };
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
  const seen = new Set<string>();
  for (const line of inside.split(/\r?\n/)) {
    const t = parseTangentLine(line);
    if (!t) continue;
    const key = t.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tangents.push(t);
    if (tangents.length >= MAX_TANGENTS) break;
  }
  const body = after.trim() === '' ? before.trimEnd() : `${before.trimEnd()}\n\n${after.trim()}`;
  return { body, tangents, partial: false };
}

/** Renders tangents in the block format the prompt asks for (used by the demo). */
export function formatTangents(tangents: readonly Tangent[]): string {
  const lines = tangents.map((t) => (t.why ? `- ${t.title} — ${t.why}` : `- ${t.title}`));
  return `${TANGENTS_OPEN}\n${lines.join('\n')}\n${TANGENTS_CLOSE}`;
}
