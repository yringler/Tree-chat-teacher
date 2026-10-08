import { tex } from '@mdit/plugin-tex';
import type { MarkdownIt } from 'markdown-it';

/**
 * Turns TeX source into HTML. `displayMode` is true for `\[…\]` / `$$…$$`.
 * The result is inserted verbatim, so it must already be safe HTML.
 */
export type MathRenderer = (tex: string, displayMode: boolean) => string;

/** The markdown-it `env` that `renderMarkdown` passes through to the math rules. */
export interface MathEnv {
  math?: MathRenderer | undefined;
}

/**
 * Default renderer: the TeX source, HTML-escaped. The client typesets these
 * placeholders in the DOM after Angular's sanitizer has run (see
 * web-shared `typesetMath`), because the sanitizer strips KaTeX's inline
 * styles and MathML.
 */
const sourceOnly: MathRenderer = (source) =>
  source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * markdown-it plugin: TeX math in all four delimiters, parsed before
 * Markdown escapes can eat its backslashes (`\[` → `[`, `\\` → `\`).
 * @mdit/plugin-tex does the parsing: display blocks are taken whole (so TeX
 * lines like `- x` never become lists), `$` follows Pandoc's rules (so
 * "$5 and $10" stays text), code is left alone, and unclosed math (still
 * streaming) stays text. Display math must start its own line.
 *
 * Output: `<span class="math math-inline">` / `<div class="math math-display">`
 * holding `env.math(tex)`.
 */
export function mathPlugin(md: MarkdownIt): void {
  md.use(tex, {
    delimiters: 'all',
    render: (source, displayMode, env) => {
      const html = ((env as MathEnv).math ?? sourceOnly)(source.trim(), displayMode);
      return displayMode
        ? `<div class="math math-display">${html}</div>\n`
        : `<span class="math math-inline">${html}</span>`;
    },
  });
}
