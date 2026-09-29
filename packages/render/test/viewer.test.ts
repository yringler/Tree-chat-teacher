import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/markdown.js';
import { renderViewerPage, VIEWER_SCRIPT, VIEWER_STYLE, viewerCsp } from '../src/viewer.js';
import { CONTENT_MARKERS, samplePayload } from './fixture.js';

const FIXED_IDS = [
  'outline-toggle',
  'outline',
  'scrim',
  'main',
  'crumbs',
  'context',
  'thread',
  'store',
  'tangent-data',
];

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
}

function inlineStyles(html: string): string[] {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');
}

function structureText(html: string): string {
  const m = /<script type="application\/json" id="tangent-data">([\s\S]*?)<\/script>/.exec(html);
  if (!m?.[1]) throw new Error('no structure json');
  return m[1];
}

describe('renderViewerPage', () => {
  const payload = samplePayload();
  const html = renderViewerPage(payload, {
    variant: 'share',
    url: 'https://t.example/s/abc?x=1&y="2"',
  });

  it('is a complete HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('contains every message pre-rendered with renderMarkdown', () => {
    for (const m of [...(payload.context ?? []), ...payload.branches.flatMap((b) => b.messages)]) {
      expect(html).toContain(renderMarkdown(m.content));
    }
    expect(html).toContain('<code class="hljs language-typescript">');
  });

  it('never emits message content as markup', () => {
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(inlineScripts(html)).toEqual([VIEWER_SCRIPT]);
    expect(inlineStyles(html)).toEqual([VIEWER_STYLE]);
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(html.match(/<style\b/g)).toHaveLength(1);
  });

  it('uses no element ids other than payload keys and fixed layout ids', () => {
    const keys = new Set<string>([
      ...payload.branches.map((b) => b.key),
      ...payload.branches.flatMap((b) => b.messages.map((m) => m.key)),
      ...(payload.context ?? []).map((m) => m.key),
    ]);
    const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1] ?? '');
    for (const id of ids) expect(keys.has(id) || FIXED_IDS.includes(id)).toBe(true);
    // Each key id appears at most once (no duplicate anchors).
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);
  });

  it('loads no external resources', () => {
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\ssrc=/i);
    expect(html).not.toMatch(/@import|url\(/i);
    // The only absolute URLs are og:url and the link inside message content.
    const urls = [...html.matchAll(/https?:\/\/[^"'\s<]+/g)].map((m) => m[0]);
    for (const u of urls)
      expect(u.startsWith('https://example.com') || u.startsWith('https://t.example/')).toBe(true);
  });

  it('escapes head metadata', () => {
    const t = 'Trees &amp; &quot;Branches&quot; &lt;script&gt;alert(1)&lt;/script&gt;';
    const desc = 'How do &lt;trees&gt; work? &quot;quoted&quot; &amp; more';
    expect(html).toContain(`<title>${t}</title>`);
    expect(html).toContain(`<meta name="description" content="${desc}">`);
    expect(html).toContain(`<meta property="og:title" content="${t}">`);
    expect(html).toContain(`<meta property="og:description" content="${desc}">`);
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain(
      '<meta property="og:url" content="https://t.example/s/abc?x=1&amp;y=&quot;2&quot;">',
    );
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('Shared with Tangent · read-only');
  });

  it('escapes branch titles and anchor quotes', () => {
    expect(html).toContain('Side &lt;b&gt;topic&lt;/b&gt;');
    expect(html).not.toContain('<b>topic');
    expect(html).toContain(
      '<blockquote class="anchor">ANCHORQ the &quot;quote&quot; &lt;i&gt;</blockquote>',
    );
  });

  it('shows fork indicators linking to child branches', () => {
    expect(html).toContain('<summary>2 branches</summary>');
    expect(html).toContain('<summary>1 branch</summary>');
    expect(html).toContain('href="#b1" data-branch="b1"');
    expect(html).toContain('href="#b3" data-branch="b3"');
    expect(html).toContain('↩ back to parent message');
  });

  it('renders the outline with message counts in depth-first order', () => {
    const outline = /<nav class="outline"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    const order = [...outline.matchAll(/data-branch="(b\d+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
    expect(outline).toMatch(/Trunk<\/span><span class="count"[^>]*>4<\/span>/);
    expect(outline).toMatch(/Other<\/span><span class="count"[^>]*>0<\/span>/);
  });

  it('renders earlier context in a collapsed details element', () => {
    expect(html).toMatch(
      /<details class="context" id="context"><summary>Earlier context · 2 messages<\/summary>/,
    );
    const noContext = renderViewerPage(samplePayload({ context: null }), { variant: 'share' });
    expect(noContext).not.toContain('class="context"');
  });

  it('embeds only the structure as JSON, without message content', () => {
    const raw = structureText(html);
    expect(raw).not.toMatch(/[<>&]/);
    const data = JSON.parse(raw) as {
      rootBranchKey: string;
      context: { key: string; role: string }[] | null;
      branches: {
        key: string;
        parentKey: string | null;
        forkMessageKey: string | null;
        title: string;
        messages: { key: string; role: string }[];
      }[];
    };
    expect(data.rootBranchKey).toBe('b0');
    expect(data.context).toEqual([
      { key: 'm0', role: 'user' },
      { key: 'm1', role: 'assistant' },
    ]);
    expect(data.branches.map((b) => [b.key, b.parentKey, b.forkMessageKey])).toEqual([
      ['b0', null, null],
      ['b1', 'b0', 'm3'],
      ['b2', 'b1', 'm6'],
      ['b3', 'b0', 'm3'],
      ['b4', 'b0', 'm5'],
    ]);
    expect(data.branches[1]?.title).toBe('Side <b>topic</b>');
    expect(data.branches[0]?.messages[1]).toEqual({ key: 'm3', role: 'assistant' });
    for (const marker of CONTENT_MARKERS) expect(raw).not.toContain(marker);
  });

  it('export variant has a dated footer, no noindex and no og:url', () => {
    const exported = renderViewerPage(payload, {
      variant: 'export',
      url: 'https://ignored.example',
    });
    expect(exported).toContain('Exported from Tangent on September 29, 2026');
    expect(exported).not.toContain('noindex');
    expect(exported).not.toContain('og:url');
    expect(exported).not.toContain('Content-Security-Policy');
  });

  it('ships a syntactically valid inline script with no interpolation', () => {
    expect(() => new Function(VIEWER_SCRIPT)).not.toThrow();
    expect(VIEWER_SCRIPT).not.toContain('</script');
    expect(VIEWER_STYLE).not.toContain('</style');
  });

  it('shows an empty branch placeholder', () => {
    expect(html).toContain('No messages in this branch.');
  });
});

describe('viewerCsp', () => {
  it('hashes exactly the inline script and style of the page', async () => {
    const csp = await viewerCsp();
    const html = renderViewerPage(samplePayload(), { variant: 'share', csp });
    const [script] = inlineScripts(html);
    const [style] = inlineStyles(html);
    expect(script).toBeDefined();
    expect(style).toBeDefined();
    expect(csp).toContain(`script-src 'sha256-${await sha256Base64(script ?? '')}'`);
    expect(csp).toContain(`style-src 'sha256-${await sha256Base64(style ?? '')}'`);
    expect(csp).toMatch(/^default-src 'none'; /);
    for (const d of [
      'img-src https: data:',
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(d);
    }
  });

  it('is memoized', async () => {
    expect(viewerCsp()).toBe(viewerCsp());
    expect(await viewerCsp()).toBe(await viewerCsp());
  });

  it('is embedded as a meta tag without meta-ignored directives', async () => {
    const csp = await viewerCsp();
    const html = renderViewerPage(samplePayload(), { variant: 'share', csp });
    const meta =
      /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1] ?? '';
    const decoded = meta.replace(/&#39;/g, "'");
    expect(decoded).toBe(csp.replace(/; frame-ancestors 'none'/, ''));
    // The CSP meta precedes the inline style.
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<style>'));
  });
});
