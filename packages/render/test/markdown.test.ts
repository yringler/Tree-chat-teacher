import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown } from '../src/markdown.js';

/** Markup that must never appear in rendered output. */
function expectInert(html: string): void {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<iframe/i);
  expect(html).not.toMatch(/<object/i);
  expect(html).not.toMatch(/<embed/i);
  expect(html).not.toMatch(/<svg/i);
  expect(html).not.toMatch(/<style/i);
  // Attribute names only (output values are always double-quoted with `"` escaped).
  for (const tag of html.matchAll(/<[a-zA-Z][\w-]*((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    const names = (tag[1] ?? '')
      .replace(/="[^"]*"/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const name of names)
      expect(['href', 'src', 'alt', 'title', 'class', 'target', 'rel', 'start']).toContain(name);
  }
  expect(html).not.toMatch(/href\s*=\s*"\s*(?:javascript|vbscript|data|file):/i);
  expect(html).not.toMatch(/src\s*=\s*"\s*(?:javascript|vbscript|data:text)/i);
  // Every tag in the output comes from markdown-it / highlight.js.
  const tags = [...html.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1]?.toLowerCase());
  const allowed = new Set([
    'p',
    'a',
    'em',
    'strong',
    'code',
    'pre',
    'span',
    'ul',
    'ol',
    'li',
    'blockquote',
    'img',
    'br',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    's',
  ]);
  for (const t of tags) expect(allowed).toContain(t);
}

const XSS_CORPUS = [
  '<script>alert(1)</script>',
  'hello <script src="https://evil.example/x.js"></script>',
  '<img src=x onerror=alert(1)>',
  '<img src="x" onerror="alert(1)">',
  '<iframe src="https://evil.example"></iframe>',
  '<svg onload=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](  javascript:alert(1))',
  '[x](java\tscript:alert(1))',
  '[x](&#106;avascript:alert(1))',
  '[x](vbscript:msgbox(1))',
  '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[x](file:///etc/passwd)',
  '![x](javascript:alert(1))',
  '![x](data:text/html,<script>alert(1)</script>)',
  '<javascript:alert(1)>',
  '<vbscript:msgbox(1)>',
  'javascript:alert(1)',
  '[x][ref]\n\n[ref]: javascript:alert(1)',
  '```"><script>alert(1)</script>\ncode\n```',
  '```js" onmouseover="alert(1)\ncode\n```',
  '```<img src=x onerror=alert(1)>\ncode\n```',
  '`<script>alert(1)</script>`',
  '[<img src=x onerror=alert(1)>](https://ok.example)',
  '[x](https://ok.example "title\\" onmouseover=\\"alert(1)")',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<!-- <script>alert(1)</script> -->',
  '<details open ontoggle=alert(1)>',
];

describe('renderMarkdown: XSS corpus', () => {
  for (const input of XSS_CORPUS) {
    it(`neutralizes ${JSON.stringify(input)}`, () => {
      expectInert(renderMarkdown(input));
    });
  }

  it('escapes raw HTML instead of dropping it', () => {
    expect(renderMarkdown('<b>hi</b>')).toBe('<p>&lt;b&gt;hi&lt;/b&gt;</p>\n');
  });

  it('keeps the code fence info string out of attributes', () => {
    const html = renderMarkdown('```"><script>alert(1)</script>\ncode\n```');
    expect(html).toBe('<pre><code class="hljs">code\n</code></pre>\n');
  });
});

describe('renderMarkdown: links', () => {
  it('adds target and rel to links', () => {
    expect(renderMarkdown('[x](https://example.com)')).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">x</a></p>\n',
    );
  });

  it('linkifies bare URLs and autolinks with the same attributes', () => {
    for (const src of ['see https://example.com/a?b=1', '<https://example.com/a?b=1>']) {
      const html = renderMarkdown(src);
      expect(html).toContain('href="https://example.com/a?b=1"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer nofollow"');
    }
  });

  it('allows image data URLs', () => {
    expect(renderMarkdown('![i](data:image/png;base64,AAAA)')).toContain(
      'src="data:image/png;base64,AAAA"',
    );
  });
});

describe('renderMarkdown: code', () => {
  it('highlights known languages with hljs classes', () => {
    const html = renderMarkdown('```ts\nconst a: string = "<b>";\n```');
    expect(html).toMatch(/^<pre><code class="hljs language-typescript">/);
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('&quot;&lt;b&gt;&quot;');
    expect(html).not.toContain('<b>');
  });

  it('resolves aliases to the registered language', () => {
    expect(renderMarkdown('```js\nx\n```')).toContain('language-javascript');
    expect(renderMarkdown('```py\nx\n```')).toContain('language-python');
    expect(renderMarkdown('```sh\nls\n```')).toContain('language-bash');
    expect(renderMarkdown('```html\n<div></div>\n```')).toContain('language-xml');
    expect(renderMarkdown('```yml\na: 1\n```')).toContain('language-yaml');
    expect(renderMarkdown('```c++\nint x;\n```')).toContain('language-cpp');
    for (const lang of [
      'json',
      'css',
      'sql',
      'go',
      'rust',
      'java',
      'c',
      'csharp',
      'markdown',
      'diff',
      'plaintext',
      'shell',
    ]) {
      expect(renderMarkdown('```' + lang + '\nx\n```')).toContain(`language-${lang}`);
    }
  });

  it('renders unknown languages as escaped plain code', () => {
    expect(renderMarkdown('```brainfudge\n<x> & y\n```')).toBe(
      '<pre><code class="hljs">&lt;x&gt; &amp; y\n</code></pre>\n',
    );
    expect(renderMarkdown('```\n<x>\n```')).toBe(
      '<pre><code class="hljs">&lt;x&gt;\n</code></pre>\n',
    );
  });
});

describe('renderMarkdown: basics', () => {
  it('renders common markdown', () => {
    const html = renderMarkdown('# T\n\n*a* **b**\n\n- x\n- y\n\n> q');
    expect(html).toContain('<h1>T</h1>');
    expect(html).toContain('<em>a</em> <strong>b</strong>');
    expect(html).toContain('<li>x</li>');
    expect(html).toContain('<blockquote>');
  });

  it('uses classes instead of inline styles for table alignment', () => {
    const html = renderMarkdown('| a | b |\n|:-:|--:|\n| 1 | 2 |');
    expect(html).toContain('<th class="ta-center">a</th>');
    expect(html).toContain('<td class="ta-right">2</td>');
    expect(html).not.toContain('style=');
  });

  it('does not use typographer replacements or soft breaks', () => {
    expect(renderMarkdown('"a" -- b\nc')).toBe('<p>&quot;a&quot; -- b\nc</p>\n');
  });
});

describe('escapeHtml', () => {
  it('escapes all special characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});
