import { test } from 'vitest';
import { renderMarkdown } from '../src/markdown.js';

/*
 * What streaming a reply costs in Markdown rendering alone (not part of
 * `pnpm test`): `pnpm --filter @tangent/render bench`. The chat view renders
 * the whole reply again on every delta (MessageItem.html → MarkdownService
 * .render, uncached while streaming), so a reply of N characters arriving in
 * c-character deltas costs Σ render(prefix) ≈ N²/2c. For comparison, a
 * block-incremental render: finished blocks (split at blank lines outside
 * code fences) are rendered once and kept; only the last, still-growing
 * block is rendered per delta.
 */

const PARA =
  'The **key idea** is that `branches` share a prefix, so the context of a deep branch is the ' +
  'path from the root, and every reply adds [a link](https://example.org) or two. ';

function reply(chars: number): string {
  const blocks: string[] = [];
  for (let i = 0; blocks.join('\n\n').length < chars; i++) {
    blocks.push(
      `## Section ${i}`,
      PARA.repeat(3),
      '- one point\n- another point\n- a third, *emphasized*',
    );
    if (i % 3 === 0)
      blocks.push(
        '```ts\nconst path = branchPath(index, id);\nfor (const n of path) total += n.content.length;\n```',
      );
  }
  return blocks.join('\n\n').slice(0, chars);
}

/** Splits at blank lines that are not inside a ``` fence; the last block may still grow. */
function blocks(text: string): string[] {
  const out: string[] = [];
  let fence = false;
  let start = 0;
  const lines = text.split('\n');
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('```')) fence = !fence;
    pos += line.length + 1;
    if (!fence && line === '' && i < lines.length - 1) {
      out.push(text.slice(start, pos));
      start = pos;
    }
  }
  out.push(text.slice(start));
  return out;
}

function streamFull(text: string, chunk: number): number {
  const t0 = performance.now();
  for (let i = chunk; i < text.length + chunk; i += chunk) renderMarkdown(text.slice(0, i));
  return performance.now() - t0;
}

/** The time, and the last HTML (kept so the work isn't optimized away). */
function streamIncremental(text: string, chunk: number): { ms: number; html: string } {
  const cache = new Map<string, string>();
  const t0 = performance.now();
  let last = '';
  for (let i = chunk; i < text.length + chunk; i += chunk) {
    const bs = blocks(text.slice(0, i));
    let html = '';
    for (let b = 0; b < bs.length; b++) {
      const src = bs[b]!;
      const done = b < bs.length - 1;
      let h = done ? cache.get(src) : undefined;
      if (h === undefined) {
        h = renderMarkdown(src);
        if (done) cache.set(src, h);
      }
      html += h;
    }
    last = html;
  }
  return { ms: performance.now() - t0, html: last };
}

test('markdown cost of streaming a reply, by length', () => {
  const lines: string[] = [];
  renderMarkdown(reply(4000)); // warm up
  for (const chars of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]) {
    const text = reply(chars);
    const chunk = 4; // ~one token per delta
    const deltas = Math.ceil(text.length / chunk);
    const full = streamFull(text, chunk);
    const inc = streamIncremental(text, chunk).ms;
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) renderMarkdown(text);
    const once = (performance.now() - t0) / 20;
    lines.push(
      `${String(chars).padStart(6)} chars  ${String(deltas).padStart(5)} deltas  ` +
        `render once ${once.toFixed(2).padStart(6)} ms  ` +
        `whole stream: full re-render ${full.toFixed(0).padStart(6)} ms ` +
        `(last delta ${once.toFixed(2)} ms)  incremental ${inc.toFixed(0).padStart(5)} ms`,
    );
  }
  console.log(lines.join('\n'));
}, 600_000);
