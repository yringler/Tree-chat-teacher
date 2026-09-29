/**
 * The single markdown renderer shared by the Angular app, the public viewer
 * page and the static HTML export (so they cannot diverge).
 *
 * markdown-it with `html: false` (raw HTML is escaped), linkify, default
 * `validateLink` (blocks javascript:/vbscript:/file:/non-image data: URLs),
 * links get rel="noopener noreferrer nofollow" target="_blank", and fenced
 * code is highlighted with highlight.js (a curated language subset) producing
 * `hljs` classes only. No DOM required; safe to run in Workers.
 */
export function renderMarkdown(markdown: string): string {
  void markdown;
  throw new Error('not implemented');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
