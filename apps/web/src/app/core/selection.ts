import { selectionText } from '@tangent/web-shared';

/** Text currently selected inside `container` (trimmed, formulas as TeX), or null. */
export function selectionWithin(container: Element | null): string | null {
  if (!container) return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const text = selectionText(sel).trim();
  return text ? text.slice(0, 10_000) : null;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
