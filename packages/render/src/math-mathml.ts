import katex from 'katex';

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Server-side math for the viewer page and HTML export: KaTeX's MathML-only
 * output. Browsers lay out MathML natively, so the page needs no KaTeX
 * stylesheet, fonts or inline `style` attributes (which the viewer's hashed
 * style-src CSP would block). Invalid TeX falls back to its source.
 *
 * KaTeX defaults keep this safe for model output: `trust: false` disables
 * `\href`, `\url`, `\includegraphics` and `\html*`, and `maxExpand` bounds
 * macro expansion.
 */
export function renderMathMl(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      output: 'mathml',
      throwOnError: true,
      strict: false,
    });
  } catch {
    return `<code class="math-error">${escapeText(tex)}</code>`;
  }
}
