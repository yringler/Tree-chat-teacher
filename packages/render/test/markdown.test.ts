import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown } from '../src/markdown.js';
import { renderMathMl } from '../src/math-mathml.js';

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
    'div',
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
  '\\(<script>alert(1)</script>\\)',
  '$$<img src=x onerror=alert(1)>$$',
  '\\[\n</span><script>alert(1)</script>\n\\]',
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

/** Math placeholders, as the Angular apps receive them. */
const inline = (tex: string): string => `<span class="math math-inline">${tex}</span>`;
const display = (tex: string): string => `<div class="math math-display">${tex}</div>\n`;

describe('renderMarkdown: math', () => {
  it('keeps TeX backslashes that Markdown escapes would eat', () => {
    // The bug: `\[` -> `[`, `\\` -> `\`, so nothing downstream saw math.
    const src = String.raw`\[
\begin{aligned}
z_{1,1} &= 0.41 \\[4pt]
z_{1,2} &= 0.55
\end{aligned}
\]`;
    expect(renderMarkdown(src)).toBe(
      display(String.raw`\begin{aligned}
z_{1,1} &amp;= 0.41 \\[4pt]
z_{1,2} &amp;= 0.55
\end{aligned}`),
    );
  });

  it('parses inline math in both delimiters', () => {
    expect(renderMarkdown(String.raw`a \(x_1\) b $w^2$ e`)).toBe(
      `<p>a ${inline('x_1')} b ${inline('w^2')} e</p>\n`,
    );
  });

  it('parses display math on its own lines in both delimiters', () => {
    expect(renderMarkdown('Text:\n\\[y\\]\n$$z$$\nafter')).toBe(
      `<p>Text:</p>\n${display('y')}${display('z')}<p>after</p>\n`,
    );
  });

  it('does not let emphasis or escapes touch math', () => {
    expect(renderMarkdown(String.raw`\(a_i * b_j * c\_k \{x\}\)`)).toBe(
      `<p>${inline(String.raw`a_i * b_j * c\_k \{x\}`)}</p>\n`,
    );
  });

  it('takes display blocks whose lines look like Markdown', () => {
    const html = renderMarkdown('Text:\n$$\n- a\n= b\n1. c\n$$\nafter');
    expect(html).toBe(`<p>Text:</p>\n${display('- a\n= b\n1. c')}<p>after</p>\n`);
  });

  it('finds display blocks inside list items', () => {
    expect(renderMarkdown('- item\n  \\[\n  x\n  \\]\n- next')).toBe(
      `<ul>\n<li>item${display('x')}</li>\n<li>next</li>\n</ul>\n`,
    );
  });

  it('leaves math in code alone', () => {
    expect(renderMarkdown('`\\(x\\)` and `$y$`')).toBe(
      '<p><code>\\(x\\)</code> and <code>$y$</code></p>\n',
    );
    expect(renderMarkdown('```\n$$x$$\n```')).toBe(
      '<pre><code class="hljs">$$x$$\n</code></pre>\n',
    );
  });

  it('does not treat prices as math', () => {
    for (const src of [
      'costs $5 and $10',
      'between $5-$10',
      'US$5 or $ 5$',
      'a $10/year fee, $20/year',
      'escaped \\$x\\$',
    ])
      expect(renderMarkdown(src)).not.toContain('class="math');
    expect(renderMarkdown('costs $5 and $10, so $x$ is')).toBe(
      `<p>costs $5 and $10, so ${inline('x')} is</p>\n`,
    );
  });

  it('renders unclosed math (still streaming) as text', () => {
    expect(renderMarkdown('\\[\n\\frac{a}{b}')).not.toContain('class="math');
    expect(renderMarkdown('see \\(x')).toBe('<p>see (x</p>\n');
  });

  it('does not end inline math at an escaped closer', () => {
    expect(renderMarkdown(String.raw`\(a \\ b\) and \(\$5\)`)).toBe(
      `<p>${inline(String.raw`a \\ b`)} and ${inline(String.raw`\$5`)}</p>\n`,
    );
  });

  it('passes TeX to a custom renderer', () => {
    const html = renderMarkdown('\\(x\\)\n\n$$y$$', {
      math: (tex, displayMode) => `[${displayMode ? 'D' : 'I'}:${tex}]`,
    });
    expect(html).toBe(`<p>${inline('[I:x]')}</p>\n${display('[D:y]')}`);
  });
});

describe('renderMathMl', () => {
  it('renders MathML with the TeX source as an annotation', () => {
    const html = renderMathMl('x^2', false);
    expect(html).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML">');
    expect(html).toContain('<msup><mi>x</mi><mn>2</mn></msup>');
    expect(html).toContain('<annotation encoding="application/x-tex">x^2</annotation>');
    expect(html).not.toContain('style=');
    expect(renderMathMl('x', true)).toContain('display="block"');
  });

  it('falls back to the escaped source for invalid TeX', () => {
    expect(renderMathMl('\\frac{<b>', false)).toBe(
      '<code class="math-error">\\frac{&lt;b&gt;</code>',
    );
  });

  it('keeps untrusted commands inert', () => {
    for (const tex of [
      '\\href{javascript:alert(1)}{x}',
      '\\url{javascript:alert(1)}',
      '\\includegraphics{https://evil.example/x.png}',
      '\\htmlClass{x}{y}',
      '\\htmlStyle{color:red}{y}',
      '\\htmlData{onclick=alert(1)}{y}',
      '\\text{<script>alert(1)</script>}',
    ]) {
      const html = renderMarkdown(`\\(${tex}\\)`, { math: renderMathMl });
      expect(html).not.toMatch(/<(?:script|a|img)\b/i);
      // Attributes only: the TeX source is (escaped) annotation text.
      expect(html).not.toMatch(/<[^>]*\s(?:href|src|style|on\w+)=/i);
    }
  });
});

describe('escapeHtml', () => {
  it('escapes all special characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});
