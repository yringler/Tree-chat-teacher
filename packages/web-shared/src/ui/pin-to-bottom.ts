/**
 * Keeps `scroller` at the bottom while `content` grows and `pinned()` holds
 * (a reply streaming in while the reader is at the bottom). A ResizeObserver
 * reports at most once per frame, after layout, so reading `scrollHeight`
 * there forces no layout of its own, unlike a scroll scheduled per delta.
 * Returns a function that stops it.
 */
export function pinToBottom(
  scroller: HTMLElement,
  content: Element,
  pinned: () => boolean,
): () => void {
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  const observer = new ResizeObserver(() => {
    if (pinned()) scroller.scrollTop = scroller.scrollHeight;
  });
  observer.observe(content);
  return () => observer.disconnect();
}
