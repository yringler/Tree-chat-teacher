import { test } from 'vitest';
import { BlockRenderer } from '../src/blocks.js';
import { renderMarkdown } from '../src/markdown.js';

/*
 * What streaming a reply costs in Markdown rendering alone (not part of
 * `pnpm test`): `pnpm --filter @tangent/render bench`. Rendering the whole
 * reply again on every delta (what the chat views did before BlockRenderer)
 * costs, for a reply of N characters arriving in c-character deltas,
 * Σ render(prefix) ≈ N²/2c. BlockRenderer (what they do now, at most once
 * per frame) renders each finished block once and only the last,
 * still-growing block per delta.
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

function streamFull(text: string, chunk: number): number {
  const t0 = performance.now();
  for (let i = chunk; i < text.length + chunk; i += chunk) renderMarkdown(text.slice(0, i));
  return performance.now() - t0;
}

/** The time, and the last HTML (kept so the work isn't optimized away). */
function streamIncremental(text: string, chunk: number): { ms: number; html: string } {
  const renderer = new BlockRenderer(renderMarkdown);
  const t0 = performance.now();
  let last: string[] = [];
  for (let i = chunk; i < text.length + chunk; i += chunk) last = renderer.update(text.slice(0, i));
  return { ms: performance.now() - t0, html: last.join('') };
}

test('markdown cost of streaming a reply, by length', () => {
  const lines: string[] = [];
  renderMarkdown(reply(4000)); // warm up
  for (const chars of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]) {
    const text = reply(chars);
    const chunk = 4; // ~one token per delta
    const deltas = Math.ceil(text.length / chunk);
    const full = streamFull(text, chunk);
    const { ms: inc, html } = streamIncremental(text, chunk);
    if (html !== renderMarkdown(text)) throw new Error(`blocks differ from the whole at ${chars}`);
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
