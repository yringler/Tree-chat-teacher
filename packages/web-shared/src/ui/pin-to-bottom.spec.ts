import { afterEach, describe, expect, it, vi } from 'vitest';
import { pinToBottom } from './pin-to-bottom';

/** A ResizeObserver stand-in: `resize()` delivers a report, as the browser does after layout. */
class FakeObserver {
  static last: FakeObserver | null = null;
  observed: unknown[] = [];
  disconnected = false;
  constructor(private readonly callback: () => void) {
    FakeObserver.last = this;
  }
  observe(target: unknown): void {
    this.observed.push(target);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  resize(): void {
    if (!this.disconnected) this.callback();
  }
}

describe('pinToBottom', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('scrolls to the bottom when the content grows, only while pinned', () => {
    vi.stubGlobal('ResizeObserver', FakeObserver);
    const scroller = { scrollTop: 0, scrollHeight: 500 } as HTMLElement;
    const content = {} as Element;
    let pinned = true;
    const stop = pinToBottom(scroller, content, () => pinned);
    const observer = FakeObserver.last!;
    expect(observer.observed).toEqual([content]);

    observer.resize();
    expect(scroller.scrollTop).toBe(500);

    pinned = false; // the reader scrolled up
    (scroller as { scrollHeight: number }).scrollHeight = 900;
    observer.resize();
    expect(scroller.scrollTop).toBe(500);

    pinned = true;
    observer.resize();
    expect(scroller.scrollTop).toBe(900);

    stop();
    expect(observer.disconnected).toBe(true);
  });

  it('does nothing without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const scroller = { scrollTop: 0, scrollHeight: 500 } as HTMLElement;
    expect(() => pinToBottom(scroller, {} as Element, () => true)()).not.toThrow();
    expect(scroller.scrollTop).toBe(0);
  });
});
