/*
 * Block-by-block rendering of a reply that is still streaming. Rendering the
 * whole reply again on every delta costs O(n) per delta and O(n²) per reply;
 * here the text is cut into top-level blocks, each finished block is
 * rendered once, and only the block still growing at the end is rendered
 * again. The finished reply is still rendered whole (renderMarkdown).
 */

/** A reply cut into blocks; `done.join('') + tail` is the text. */
export interface MarkdownBlocks {
  /**
   * Finished blocks, each with its trailing blank lines. Each renders alone
   * exactly as it does inside the whole text, and text appended later can't
   * change that (but for a link reference definition: then nothing splits).
   */
  done: string[];
  /** The last block, still growing (possibly empty). */
  tail: string;
}

/** A fence opener: ``` (no backticks in the info string) or ~~~, up to 3 spaces in. */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** A list item's first line, up to 3 spaces in (a 4-space one is code). */
const LIST_ITEM_RE = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
/** An unfinished last line that may still turn into a list item ("-", "12", "3."). */
const LIST_ITEM_PREFIX_RE = /^(?:[-+*]|\d{1,9}[.)]?)$/;
/** After the container markers (`>`, list markers) of a line: where a link reference definition starts. */
const CONTAINERS_RE = /^[ \t]*(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)*/;
const BLANK_RE = /^[ \t]*$/;
/** Nothing but line ends and blank lines. */
const LINE_ENDS_RE = /^(?:(?:\r\n?|\n)(?:[ \t]*(?:\r\n?|\n))*)?$/;
/** Lines with their terminators; markdown-it reads \r\n, \r and \n alike. */
const LINE_RE = /[^\r\n]*(?:\r\n?|\n)|[^\r\n]+$/g;

/**
 * Could this line start (or be) a link reference definition (`[id]: url`)?
 * A definition applies to the whole document, so text that has one is never
 * split. A complete line that opens a bracket without closing it may be the
 * first line of a multi-line label, so it counts too.
 */
function mayDefineReference(line: string, complete: boolean): boolean {
  const rest = line.slice(CONTAINERS_RE.exec(line)?.[0].length ?? 0);
  if (!rest.startsWith('[')) return false;
  return rest.includes(']:') || (complete && !rest.includes(']'));
}

/**
 * Opens display math? `$$` and `\[` blocks may span blank lines. A
 * one-line `$$…$$` or `\[…\]` closes on the same line; `$$a$$ text` is a
 * paragraph (@mdit/plugin-tex). Any indentation counts: a false positive
 * only merges blocks.
 */
function mathOpener(line: string): '$$' | '\\]' | null {
  const text = line.trim();
  if (text.startsWith('$$')) {
    const close = text.indexOf('$$', 2);
    return close === -1 ? '$$' : null;
  }
  if (text.startsWith('\\[')) return text.length >= 4 && text.endsWith('\\]') ? null : '\\]';
  return null;
}

/**
 * Splits markdown into finished blocks and the block still growing, or
 * returns null when it must not be split (it may define a link reference).
 *
 * A split falls only at a blank line, and only when every construct that
 * may span blank lines is closed: fenced code (``` or ~~~, closed by a fence
 * of the same character at least as long) and display math (`$$`, `\[`). The
 * next line must also start a block that cannot continue the previous one:
 * it must not be indented (a list item's or an indented code block's
 * continuation), and after a block holding list items it must not be a list
 * item (the same list, whose looseness depends on every item). Tables,
 * paragraphs and block quotes end at a blank line. HTML blocks never occur:
 * the renderer escapes raw HTML (`html: false`), so `<div>` is a paragraph.
 *
 * The decision waits until the next line is known: a blank line at the end,
 * or an unfinished last line that could still be a list item ("-", "1."),
 * keeps the block open. So a finished block stays finished as text is
 * appended. Anything uncertain merges blocks, which is always correct.
 */
function scan(markdown: string): MarkdownBlocks | null {
  const done: string[] = [];
  let start = 0; // where the current block starts
  let pos = 0; // where the current line starts
  let fence: { char: string; length: number } | null = null;
  let math: '$$' | '\\]' | null = null;
  let hasContent = false; // the current block has a non-blank line
  let hasList = false; // ...holding a list item
  let afterBlank = false; // a blank line ended the block's last content

  for (const match of markdown.matchAll(LINE_RE)) {
    const raw = match[0];
    const line = raw.replace(/\r?\n$|\r$/, '');
    const complete = line.length < raw.length;
    const lineStart = pos;
    pos += raw.length;

    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) fence = null;
      continue;
    }
    if (math) {
      if (line.trim().endsWith(math)) math = null;
      continue;
    }
    if (BLANK_RE.test(line)) {
      if (hasContent) afterBlank = true;
      continue;
    }

    if (afterBlank) {
      // The first line after blank lines: does it start a new block? An
      // unfinished line that may still become a list item counts as one
      // (merging now and splitting at a later update is fine; the reverse is not).
      const indented = line[0] === ' ' || line[0] === '\t';
      const listItem = LIST_ITEM_RE.test(line) || (!complete && LIST_ITEM_PREFIX_RE.test(line));
      if (!indented && !(hasList && listItem)) {
        done.push(markdown.slice(start, lineStart));
        start = lineStart;
        hasList = false;
      }
      afterBlank = false;
    }

    if (mayDefineReference(line, complete)) return null;
    hasContent = true;
    if (LIST_ITEM_RE.test(line)) hasList = true;
    const [, run = '', info = ''] = FENCE_OPEN_RE.exec(line) ?? [];
    const char = run.charAt(0);
    if (char !== '' && !(char === '`' && info.includes('`'))) {
      fence = { char, length: run.length };
      continue;
    }
    math = mathOpener(line);
  }
  return { done, tail: markdown.slice(start) };
}

/**
 * Splits markdown into finished blocks and the last, still-growing block
 * (see `scan` for the rules). Text that may define a link reference is one
 * block, as is anything after an unclosed fence or display math.
 */
export function splitBlocks(markdown: string): MarkdownBlocks {
  return scan(markdown) ?? { done: [], tail: markdown };
}

/**
 * Renders a streaming reply block by block: finished blocks are rendered
 * once and kept by their source, the growing last block is rendered again
 * on each update. While each update extends the last, only the text after
 * the finished blocks is scanned again. `render` is the full renderer (the
 * same output, sanitizing and fallbacks as for a whole reply).
 */
export class BlockRenderer {
  private done: { source: string; html: string }[] = [];
  /** The finished blocks' text, a prefix of the last update. */
  private prefix = '';
  private tail: { source: string; html: string } | null = null;

  constructor(private readonly render: (markdown: string) => string) {}

  /** HTML of each block of `markdown`, in order. */
  update(markdown: string): string[] {
    if (!markdown.startsWith(this.prefix)) this.reset();
    const split = scan(markdown.slice(this.prefix.length));
    if (!split) {
      // A link reference definition reaches every block: one block, as a whole.
      this.reset();
      return [this.renderTail(markdown)];
    }
    for (const source of split.done) {
      // The block just finished is usually the last tail plus line ends: same HTML.
      const t = this.tail;
      const html =
        t && source.startsWith(t.source) && LINE_ENDS_RE.test(source.slice(t.source.length))
          ? t.html
          : this.render(source);
      this.done.push({ source, html });
      this.prefix += source;
      this.tail = null;
    }
    const out = this.done.map((b) => b.html);
    if (split.tail !== '') out.push(this.renderTail(split.tail));
    return out;
  }

  /** Forgets every block (the reply finished, or changed other than by growing). */
  reset(): void {
    this.done = [];
    this.prefix = '';
    this.tail = null;
  }

  private renderTail(source: string): string {
    if (this.tail?.source !== source) this.tail = { source, html: this.render(source) };
    return this.tail.html;
  }
}
