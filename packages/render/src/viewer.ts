import type { SharePayload } from '@tangent/shared';

export interface ViewerPageOptions {
  /** 'share' = served at /s/:token; 'export' = downloadable single file. */
  variant: 'share' | 'export';
  /** Absolute canonical URL (share variant) for og:url. */
  url?: string;
}

/**
 * Self-contained, read-only viewer page: tree outline (collapsible, works
 * offline), linear chat view of the selected branch path, breadcrumbs back to
 * the root, "N branches" fork indicators, collapsible ancestor context,
 * mobile-friendly layout, Open Graph + Twitter tags, and a strict CSP meta tag.
 *
 * Messages are pre-rendered with `renderMarkdown`; the inline script and style
 * are constant strings (see VIEWER_CSP) so hash-based CSP works for both the
 * HTTP response and the exported file. The payload structure (keys only, no
 * content) is embedded as `<script type="application/json">`.
 */
export function renderViewerPage(payload: SharePayload, options: ViewerPageOptions): string {
  void payload;
  void options;
  throw new Error('not implemented');
}

/**
 * Content-Security-Policy for viewer pages, e.g.
 * "default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'".
 * Computed (and memoized) from the constant inline script/style with Web Crypto.
 */
export function viewerCsp(): Promise<string> {
  throw new Error('not implemented');
}
