import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  plaintext,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, fn] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, fn);

/** Canonical registered language name for a fence info word, or null. */
function resolveLanguage(info: string): string | null {
  const name = info.trim().toLowerCase();
  if (name === '') return null;
  const lang = hljs.getLanguage(name);
  if (lang === undefined) return null;
  // Map aliases (js, ts, sh, html, yml, …) to the registered name.
  for (const registered of Object.keys(LANGUAGES)) {
    if (hljs.getLanguage(registered) === lang) return registered;
  }
  return null;
}

function highlight(code: string, info: string): string {
  const lang = resolveLanguage(info);
  if (lang === null) return `<pre><code class="hljs">${escapeHtml(code)}</code></pre>`;
  const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  return `<pre><code class="hljs language-${escapeHtml(lang)}">${html}</code></pre>`;
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
  highlight,
});

const defaultLinkOpen = md.renderer.rules.link_open;
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer nofollow');
  }
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

// Table alignment: markdown-it emits `style="text-align:…"`, which a strict
// style-src CSP blocks. Use classes (`ta-left|center|right`) instead.
for (const rule of ['th_open', 'td_open'] as const) {
  md.renderer.rules[rule] = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    if (token?.attrs) {
      const align = /text-align:(left|center|right)/.exec(
        String(token.attrGet('style') ?? ''),
      )?.[1];
      token.attrs = token.attrs.filter(([name]) => name !== 'style');
      if (align) token.attrJoin('class', `ta-${align}`);
    }
    return self.renderToken(tokens, idx, options);
  };
}

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
  return md.render(markdown);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
