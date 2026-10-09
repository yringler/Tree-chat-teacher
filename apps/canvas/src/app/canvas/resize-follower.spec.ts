import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResizeFollower } from './resize-follower';

/** A ResizeObserver whose callbacks the test fires. */
class FakeObserver {
  static live = new Set<FakeObserver>();
  readonly targets = new Set<Element>();
  constructor(private readonly callback: () => void) {
    FakeObserver.live.add(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
  }
  disconnect(): void {
    this.targets.clear();
    FakeObserver.live.delete(this);
  }
  static resize(el: Element): void {
    for (const o of FakeObserver.live) if (o.targets.has(el)) o.callback();
  }
}

const element = (): Element => ({}) as Element;

describe('ResizeFollower', () => {
  afterEach(() => {
    FakeObserver.live.clear();
    vi.unstubAllGlobals();
  });

  it('follows a re-created element, and lets the old one go', () => {
    vi.stubGlobal('ResizeObserver', FakeObserver);
    const seen: Element[] = [];
    const f = new ResizeFollower((el) => seen.push(el));
    const first = element();
    f.follow(first);
    f.follow(first);
    expect(seen).toEqual([first]);

    // "Loading…" took the viewport away, then a new one was rendered.
    f.follow(null);
    const second = element();
    f.follow(second);
    expect(seen).toEqual([first, second]);
    FakeObserver.resize(second);
    FakeObserver.resize(first);
    expect(seen).toEqual([first, second, second]);
    expect(FakeObserver.live.size).toBe(1);

    f.disconnect();
    expect(FakeObserver.live.size).toBe(0);
  });
});
