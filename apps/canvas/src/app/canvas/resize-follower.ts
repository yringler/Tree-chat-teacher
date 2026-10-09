/**
 * One ResizeObserver kept on whichever element is current: an element
 * re-created by its template (the canvas viewport, after "Loading…") is
 * observed in place of the one it replaced.
 */
export class ResizeFollower {
  private observer: ResizeObserver | null = null;
  private current: Element | null = null;

  constructor(private readonly resized: (el: Element) => void) {}

  /** Observes `el` (none: nothing), reporting its size once now and on every change. */
  follow(el: Element | null): void {
    if (el === this.current) return;
    this.disconnect();
    this.current = el;
    if (!el) return;
    this.observer = new ResizeObserver(() => this.resized(el));
    this.observer.observe(el);
    this.resized(el);
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.current = null;
  }
}
