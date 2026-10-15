import { onTestFinished, vi } from 'vitest';

/** The thread scroller as `layOutThread` fakes it: what a spec sets and reads. */
export interface ThreadLayout {
  readonly scroller: HTMLElement;
  /** The thread's full height; grows like a reply being written. */
  height: number;
  scrollTop: number;
  /** Scrolls as the reader would: moves, then tells the page. */
  scrollBy(dy: number): void;
}

/**
 * happy-dom lays nothing out: gives the page's `.messages` scroller a
 * `view`-pixel window on `height` pixels of thread, and puts the elements
 * matching each selector of `at` that many pixels down the thread (others at
 * its top). Programmatic scrolls land at once and fire no scroll event, as a
 * jump within one frame doesn't.
 */
export function layOutThread(o: {
  height: number;
  view: number;
  at: Readonly<Record<string, number>>;
}): ThreadLayout {
  const scroller = document.querySelector<HTMLElement>('.messages');
  if (!scroller) throw new Error('no .messages on the page');
  let height = o.height;
  let top = 0;
  const clamp = (v: number) => Math.max(0, Math.min(v, height - o.view));
  Object.defineProperties(scroller, {
    scrollHeight: { get: () => height, configurable: true },
    clientHeight: { value: o.view, configurable: true },
    scrollTop: { get: () => top, set: (v: number) => (top = clamp(v)), configurable: true },
  });
  scroller.scrollTo = (opts?: ScrollToOptions | number, y?: number) => {
    top = clamp(typeof opts === 'number' ? (y ?? top) : (opts?.top ?? top));
  };
  const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    if (this === scroller) return new DOMRect(0, 0, 600, o.view);
    const hit = Object.entries(o.at).find(([selector]) => this.matches(selector));
    return new DOMRect(0, (hit?.[1] ?? 0) - top, 600, 40);
  });
  onTestFinished(() => rect.mockRestore());
  return {
    scroller,
    get height() {
      return height;
    },
    set height(v: number) {
      height = v;
    },
    get scrollTop() {
      return top;
    },
    set scrollTop(v: number) {
      top = clamp(v);
    },
    scrollBy(dy: number) {
      top = clamp(top + dy);
      scroller.dispatchEvent(new Event('scroll'));
    },
  };
}
