import { afterRenderEffect, Directive, ElementRef, inject, input } from '@angular/core';

type Katex = typeof import('katex').default;

/** Loaded on first use: most messages have no math, and KaTeX is ~270 kB. */
let katex: Katex | null = null;
let loading: Promise<Katex> | null = null;

/**
 * Typesets the math placeholders `renderMarkdown` emits under `root`
 * (`<span class="math math-inline|math-display">` holding TeX source).
 *
 * This runs on the live DOM, after [innerHTML] has inserted the sanitized
 * HTML: Angular's sanitizer would strip the inline styles and MathML that
 * KaTeX output needs. `katex.render` builds nodes with createElement and
 * sets styles through CSSOM, so it needs no Trusted Types policy. Invalid TeX
 * (or a half-streamed formula) keeps its source text.
 */
export function typesetMath(root: HTMLElement): void {
  const pending = root.querySelectorAll<HTMLElement>('.math:not(.math-done)');
  if (pending.length === 0) return;
  if (!katex) {
    loading ??= import('katex').then((m) => (katex = m.default));
    loading.then(
      () => typesetMath(root),
      (err: unknown) => {
        loading = null; // e.g. a chunk lost to a deploy; retry on the next render
        console.error('KaTeX failed to load', err);
      },
    );
    return;
  }
  for (const el of pending) {
    const tex = el.textContent ?? '';
    el.classList.add('math-done');
    try {
      katex.render(tex, el, {
        displayMode: el.classList.contains('math-display'),
        throwOnError: true,
        strict: false,
      });
    } catch {
      el.textContent = tex; // render() empties the element before parsing
      el.classList.add('math-error');
    }
  }
}

/**
 * Put next to `[innerHTML]`, bound to the same HTML string:
 * `<div [innerHTML]="html()" [appTypesetMath]="html()">`. Typesets after
 * every DOM update that changes the HTML. MarkdownView puts one on each
 * block, so a streaming reply typesets only the block that changed.
 */
@Directive({ selector: '[appTypesetMath]' })
export class TypesetMath {
  readonly appTypesetMath = input.required<string>();

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterRenderEffect(() => {
      this.appTypesetMath();
      typesetMath(host);
    });
  }
}

function mathAround(node: Node | null | undefined): Element | null {
  let el = node?.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  for (; el; el = el.parentElement) if (el.classList?.contains('katex')) return el;
  return null;
}

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'TABLE', 'TR', 'HR',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]); // prettier-ignore

function plainText(node: Node, out: string[], pre: boolean): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      const data = (child as Text).data;
      out.push(pre ? data : data.replace(/\s+/g, ' '));
    } else if (child.nodeType === 1) {
      const el = child as Element;
      if (el.tagName === 'BR') {
        out.push('\n');
        continue;
      }
      const block = BLOCK_TAGS.has(el.tagName) || el.classList.contains('math-display');
      if (block) out.push('\n');
      else if (el.tagName === 'TD' || el.tagName === 'TH') out.push(' ');
      plainText(el, out, pre || el.tagName === 'PRE');
      if (block) out.push('\n');
    }
  }
}

/**
 * The text of a selection, with each typeset formula as its TeX source in
 * `\(…\)` / `\[…\]`. `Selection.toString()` alone would return KaTeX's
 * visual glyphs followed by its hidden MathML text, run together. A
 * selection that starts or ends inside a formula takes the whole formula.
 */
export function selectionText(selection: Selection): string {
  const range = selection.getRangeAt(0);
  const startMath = mathAround(range.startContainer);
  const endMath = mathAround(range.endContainer);
  const common = range.commonAncestorContainer;
  const commonEl = common.nodeType === 1 ? (common as Element) : common.parentElement;
  if (!startMath && !endMath && !commonEl?.querySelector?.('.katex')) return selection.toString();

  const whole = range.cloneRange();
  if (startMath) whole.setStartBefore(startMath);
  if (endMath) whole.setEndAfter(endMath);
  const fragment = whole.cloneContents();
  for (const k of Array.from(fragment.querySelectorAll('.katex'))) {
    const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex == null) continue;
    k.replaceWith(k.closest('.katex-display') ? `\\[${tex}\\]` : `\\(${tex}\\)`);
  }
  const out: string[] = [];
  plainText(fragment, out, false);
  return out
    .join('')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
