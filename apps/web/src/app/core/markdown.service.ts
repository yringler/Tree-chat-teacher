import { Injectable } from '@angular/core';
import { escapeHtml, renderMarkdown } from '@tangent/render';

/**
 * Memoized wrapper around the shared renderer. The output is bound with
 * [innerHTML], so Angular's sanitizer runs as a second layer.
 */
@Injectable({ providedIn: 'root' })
export class MarkdownService {
  private readonly cache = new Map<string, string>();
  private readonly max = 300;

  /** `cache: false` for text that is still streaming (every delta is a new string). */
  render(markdown: string, cache = true): string {
    const hit = this.cache.get(markdown);
    if (hit !== undefined) return hit;
    let html: string;
    try {
      html = renderMarkdown(markdown);
    } catch (err) {
      console.error('renderMarkdown failed', err);
      html = `<p class="plain">${escapeHtml(markdown)}</p>`;
    }
    if (!cache) return html;
    if (this.cache.size >= this.max) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(markdown, html);
    return html;
  }
}
