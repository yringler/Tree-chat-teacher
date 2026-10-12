import type { MarkdownIt } from 'markdown-it';

/**
 * Whether a fence's info string makes it a diagram: its first word is exactly
 * `mermaid`, case-sensitive, as on GitHub. The Flutter app applies the same rule.
 */
export function isDiagramInfo(info: string): boolean {
  return info.trim().split(/\s+/)[0] === 'mermaid';
}

/**
 * markdown-it plugin: a ```mermaid (or ~~~mermaid) fence becomes
 * `<div class="diagram">` around the plain, escaped code block. Angular's
 * sanitizer drops SVG and data attributes, so the apps draw the diagram on the
 * live DOM afterwards (web-shared `RenderDiagrams`) from the code block's
 * text; until then, and wherever nothing draws it (a streaming reply, the
 * share viewer), the reader sees the source as ordinary code.
 */
export function diagramPlugin(md: MarkdownIt): void {
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token && isDiagramInfo(md.utils.unescapeAll(token.info))) {
      const code = md.utils.escapeHtml(token.content);
      return `<div class="diagram"><pre><code class="hljs">${code}</code></pre></div>\n`;
    }
    return fence ? fence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}

/**
 * The longest diagram source that is drawn; a longer one is shown as code.
 * Mermaid's own limit is set to it too, and the Flutter app uses the same.
 */
export const MAX_DIAGRAM_SOURCE = 20_000;
