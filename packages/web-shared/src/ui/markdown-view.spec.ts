import '@angular/compiler'; // JIT: compiles the component below without the Angular CLI.
import { reflectComponentType } from '@angular/core';
import { renderMarkdown, splitBlocks } from '@tangent/render';
import { describe, expect, it } from 'vitest';
import * as shared from '../index';
import { MarkdownView, StreamedMarkdown, type FrameScheduler } from './markdown-view';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

/** Frames run by hand; `pending` is how many are waiting. */
function manualFrames(): { scheduler: FrameScheduler; run(): void; pending(): number } {
  let queue: (() => void)[] = [];
  return {
    scheduler: (callback) => {
      queue.push(callback);
      return () => (queue = queue.filter((c) => c !== callback));
    },
    run: () => {
      const due = queue;
      queue = [];
      for (const c of due) c();
    },
    pending: () => queue.length,
  };
}

/** A StreamedMarkdown over the real renderer, counting what it renders. */
function streamed(): {
  stream: StreamedMarkdown;
  frames: ReturnType<typeof manualFrames>;
  calls: string[];
} {
  const frames = manualFrames();
  const calls: string[] = [];
  const stream = new StreamedMarkdown((md) => {
    calls.push(md);
    return renderMarkdown(md);
  }, frames.scheduler);
  return { stream, frames, calls };
}

const REPLY =
  '## Trees\n\nA **tree** has [branches](https://example.org).\n\n' +
  '```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n- one\n- two\n\n  more of two\n\n' +
  '| a | b |\n|---|---|\n| 1 | 2 |\n\n$$\nx^2\n\n$$\n\nThe end.';

describe('StreamedMarkdown', () => {
  it('renders a frame’s first delta at once, and the rest of the frame’s at the next', () => {
    const { stream, frames, calls } = streamed();
    stream.push('Hel');
    expect(stream.html()).toEqual(['<p>Hel</p>\n']);
    const before = calls.length;
    stream.push('Hello');
    stream.push('Hello, wor');
    stream.push('Hello, world');
    expect(stream.html()).toEqual(['<p>Hel</p>\n']); // not twice in one frame
    expect(frames.pending()).toBe(1);
    frames.run();
    expect(stream.html()).toEqual(['<p>Hello, world</p>\n']);
    expect(calls.length - before).toBe(1); // three deltas, one render
    // That render was the next frame's: a delta in it waits again.
    stream.push('Hello, world!');
    expect(stream.html()).toEqual(['<p>Hello, world</p>\n']);
    frames.run();
    expect(stream.html()).toEqual(['<p>Hello, world!</p>\n']);
    // A quiet frame ends the wait: the next delta renders at once.
    frames.run();
    expect(frames.pending()).toBe(0);
    stream.push('Hello, world!!');
    expect(stream.html()).toEqual(['<p>Hello, world!!</p>\n']);
  });

  it('once the whole reply is in, its blocks are exactly the full render', () => {
    const { stream, frames } = streamed();
    for (let i = 0; i <= REPLY.length; i += 5) {
      stream.push(REPLY.slice(0, i));
      if (i % 15 === 0) frames.run();
    }
    stream.push(REPLY);
    frames.run();
    expect(stream.html().join('')).toBe(renderMarkdown(REPLY));
    expect(stream.html().length).toBeGreaterThan(5);
  });

  it('renders each finished block once; later frames render only the last block', () => {
    const { stream, frames, calls } = streamed();
    for (let i = 1; i <= REPLY.length; i++) {
      stream.push(REPLY.slice(0, i));
      frames.run();
      stream.html();
    }
    const { done } = splitBlocks(REPLY);
    expect(done.length).toBeGreaterThan(5);
    // A finished block is rendered at most once in its final form (usually never:
    // its last render as the growing tail is kept), and no render spans two blocks.
    for (const b of done) expect(calls.filter((c) => c === b).length).toBeLessThanOrEqual(1);
    for (const c of calls)
      expect(done.some((b) => c.length > b.length && c.includes(b))).toBe(false);
    // One render per frame: the growing block's.
    expect(calls.length).toBeLessThanOrEqual(REPLY.length + done.length);
    expect(stream.html().join('')).toBe(renderMarkdown(REPLY));
  });

  it('stop drops the pending frame and the blocks', () => {
    const { stream, frames } = streamed();
    stream.push('One.\n\nTwo');
    stream.push('One.\n\nTwo more');
    expect(frames.pending()).toBe(1);
    stream.stop();
    expect(frames.pending()).toBe(0);
    expect(stream.html()).toEqual([]);
    stream.push('New');
    expect(stream.html()).toEqual(['<p>New</p>\n']);
  });
});

describe('MarkdownView', () => {
  const t = templateOf(MarkdownView);

  it('is [appMarkdown], exported for the three apps', () => {
    expect(reflectComponentType(MarkdownView)?.selector).toBe('[appMarkdown]');
    expect(shared.MarkdownView).toBe(MarkdownView);
  });

  it('binds each block with [innerHTML] (sanitized) and typesets math per block', () => {
    expect(t).toContain('@for (b of blocks(); track $index)');
    expect(t).toContain('<div class="md-block" [innerHTML]="b" [appTypesetMath]="b"></div>');
    expect(t).not.toMatch(/bypassSecurity|outerHTML/);
  });
});
