import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ChatNode } from '@tangent/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { layOutThread, node, render } from '../testing';
import type { LiveReply } from './conversation-store';
import { ThreadEnds, ThreadScroll } from './thread-scroll';

/** The thread a page shows: the main thread, u1 → a1, nothing streaming. */
const thread = () => ({
  selectedBranchId: signal<string | null>('trunk'),
  focusedInPath: signal<ChatNode | null>(null),
  path: signal<ChatNode[]>([
    node('u1', { role: 'user', content: 'What is light?' }),
    node('a1', { parentId: 'u1', seq: 1, content: 'A wave.' }),
  ]),
  firstNodeOf: (): ChatNode | null => null,
  streamingNode: signal<ChatNode | null>(null),
  live: signal<ReadonlyMap<string, LiveReply>>(new Map()),
});
let source = thread();

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="messages" (scroll)="thread.onScroll()">
    <div class="messages-inner"></div>
  </div>`,
})
class Page {
  readonly thread = new ThreadScroll({
    store: source,
    scroller: () => document.querySelector<HTMLElement>('.messages') ?? undefined,
  });
}

/** A 500px view on 3000px of thread, scrolled 1000px down: far from either end. */
async function page() {
  const r = await render(Page);
  const view = layOutThread({ height: 3000, view: 500, at: {} });
  await new Promise(requestAnimationFrame);
  view.scrollBy(1000 - view.scrollTop);
  const scrollTo = vi.spyOn(view.scroller, 'scrollTo');
  return { ...r, view, scrollTo, thread: r.component.thread };
}

function lessMotion(on: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('reduced-motion') }));
}

beforeEach(() => (source = thread()));
afterEach(() => vi.unstubAllGlobals());

describe('ThreadScroll', () => {
  it('offers the jump to the end while the end is more than half a view below', async () => {
    const p = await page();
    expect(p.thread.farFromEnd()).toBe(true);
    // 240px below, under half the view; then 260px.
    p.view.scrollBy(2260 - p.view.scrollTop);
    expect(p.thread.farFromEnd()).toBe(false);
    p.view.scrollBy(-20);
    expect(p.thread.farFromEnd()).toBe(true);
  });

  it('a long way to either end is a jump; the end is then followed', async () => {
    lessMotion(false);
    const p = await page();
    p.view.scrollBy(-1000);
    p.thread.toEnd();
    expect(p.scrollTo).toHaveBeenLastCalledWith({ top: 2500, behavior: 'instant' });
    expect(p.thread.farFromEnd()).toBe(false);
    // Text arrives below: followed.
    p.view.height = 3400;
    source.streamingNode.set(node('a1', { status: 'streaming' }));
    source.live.set(
      new Map([
        [
          'a1',
          {
            nodeId: 'a1',
            treeId: 't1',
            branchId: 'trunk',
            content: 'A wave',
            status: null,
            reconnecting: false,
          },
        ],
      ]),
    );
    await p.fixture.whenStable();
    await new Promise(requestAnimationFrame);
    expect(p.view.scrollTop).toBe(2900);
  });

  it('a short way glides, unless the reader asked for less motion', async () => {
    lessMotion(false);
    const p = await page();
    p.thread.toStart();
    expect(p.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });
    p.view.scrollBy(1000);
    lessMotion(true);
    p.thread.toStart();
    expect(p.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' });
  });

  it('Home and End reach the thread on screen, and nothing once it is gone', async () => {
    lessMotion(true);
    const p = await page();
    const ends = TestBed.inject(ThreadEnds);
    expect(ends.toStart()).toBe(true);
    expect(p.view.scrollTop).toBe(0);
    expect(ends.toEnd()).toBe(true);
    expect(p.view.scrollTop).toBe(2500);
    p.fixture.destroy();
    expect(ends.toEnd()).toBe(false);
  });
});
