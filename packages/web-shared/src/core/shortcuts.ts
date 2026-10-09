import type { NavDirection } from '@tangent/core/tree';

/** One row of an app's shortcut help. */
export interface ShortcutHelp {
  keys: string[];
  label: string;
}

/** What `dispatchShortcut` needs from an app. */
export interface ShortcutFrame {
  /** Escape: closes the app's top-most overlay; true when one closed. */
  closeTop(): boolean;
  /** A modal dialog is open: shortcuts other than Escape and `?` wait. */
  dialogOpen(): boolean;
  /** `?`: shows or hides the app's shortcut help, where it has one. */
  toggleHelp?(): void;
  /** Alt+arrows, where the app moves among branches; true when it moved (the key is then taken). */
  navigate?(step: NavDirection): boolean;
  /** The app's plain keys; one that returns false leaves the key to the browser. */
  keys?: Readonly<Record<string, () => unknown>>;
}

const ALT_STEPS: Readonly<Record<string, NavDirection>> = {
  ArrowUp: 'parent',
  ArrowDown: 'firstChild',
  ArrowLeft: 'prevSibling',
  ArrowRight: 'nextSibling',
};

/** What the dispatcher reads of a keydown. */
export type ShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing' | 'defaultPrevented' | 'preventDefault'
> & { readonly target: unknown };

function isTyping(target: unknown): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * The document keydown of an app with shortcuts. Escape closes the top-most
 * overlay (the shared Modal relies on it), else leaves the field being typed
 * in. Everything else is ignored while typing, with Ctrl or Cmd (the
 * browser's), and, but for `?`, while a dialog is open, so no shortcut acts
 * behind a modal.
 */
export function dispatchShortcut(e: ShortcutEvent, frame: ShortcutFrame): void {
  if (e.defaultPrevented || e.isComposing) return;
  if (e.key === 'Escape') {
    if (frame.closeTop()) e.preventDefault();
    else if (isTyping(e.target) && e.target instanceof HTMLElement) e.target.blur();
    return;
  }
  if (isTyping(e.target) || e.ctrlKey || e.metaKey) return;
  if (e.key === '?' && frame.toggleHelp) {
    frame.toggleHelp();
    e.preventDefault();
    return;
  }
  if (frame.dialogOpen()) return;
  if (e.altKey) {
    const step = ALT_STEPS[e.key];
    if (step && frame.navigate?.(step)) e.preventDefault();
    return;
  }
  const run = frame.keys?.[e.key];
  if (run && run() !== false) e.preventDefault();
}
