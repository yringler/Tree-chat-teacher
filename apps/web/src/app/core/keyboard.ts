import { inject, Injectable } from '@angular/core';
import { TextSizeStore } from '@tangent/web-shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { selectionWithin } from './selection';

export interface ShortcutHelp {
  keys: string[];
  label: string;
}

export const SHORTCUTS: readonly ShortcutHelp[] = [
  { keys: ['Alt+↑', '['], label: 'Parent branch (at the branch point)' },
  { keys: ['Alt+←', 'Alt+→'], label: 'Previous / next sibling branch' },
  { keys: ['Alt+↓', ']'], label: 'First child branch' },
  { keys: ['j', 'k'], label: 'Next / previous message' },
  { keys: ['b'], label: 'Branch from the focused message' },
  { keys: ['v'], label: 'Review up to the focused (or latest) reply' },
  { keys: ['/'], label: 'Focus the composer' },
  { keys: ['i'], label: 'Toggle the context inspector' },
  { keys: ['+', '-'], label: 'Larger / smaller conversation text' },
  { keys: ['0'], label: 'Reset the conversation text size' },
  { keys: ['?'], label: 'Show this help' },
  { keys: ['Esc'], label: 'Close dialogs and panels' },
];

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Global shortcuts. Ignored while typing (except Escape) and while a dialog is open. */
@Injectable({ providedIn: 'root' })
export class Keyboard {
  private readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);
  private readonly textSize = inject(TextSizeStore);

  handle(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === 'Escape') {
      if (this.ui.closeTop()) e.preventDefault();
      else if (isTyping(e.target) && e.target instanceof HTMLElement) e.target.blur();
      return;
    }
    if (isTyping(e.target) || e.ctrlKey || e.metaKey) return;
    if (e.key === '?') {
      this.ui.shortcutsOpen.update((v) => !v);
      e.preventDefault();
      return;
    }
    if (this.ui.anyDialogOpen()) return;
    const onTree = this.store.index() !== null;

    if (e.altKey) {
      const dir =
        e.key === 'ArrowUp'
          ? 'parent'
          : e.key === 'ArrowDown'
            ? 'firstChild'
            : e.key === 'ArrowLeft'
              ? 'prevSibling'
              : e.key === 'ArrowRight'
                ? 'nextSibling'
                : null;
      if (dir && onTree) {
        e.preventDefault();
        this.store.navigate(dir);
      }
      return;
    }

    switch (e.key) {
      case '[':
        if (onTree) this.store.navigate('parent');
        break;
      case ']':
        if (onTree) this.store.navigate('firstChild');
        break;
      case 'j':
        this.store.moveFocus(1);
        break;
      case 'k':
        this.store.moveFocus(-1);
        break;
      case 'b': {
        const node = this.store.focusedInPath() ?? this.store.leaf();
        // Nothing to branch onto without a route to generate on (power is read-only).
        if (!node || !this.store.canGenerate()) return;
        const body = document.getElementById(`msg-${node.id}`)?.querySelector('.msg-body') ?? null;
        this.ui.branchDialog.set({ fromNodeId: node.id, quote: selectionWithin(body) });
        break;
      }
      case 'v': {
        // The focused reply, else the last reply above the focused message (or overall).
        const path = this.store.path();
        const focused = this.store.focusedInPath();
        const upTo = focused ? path.slice(0, path.indexOf(focused) + 1) : path;
        const node = upTo.findLast((n) => n.role === 'assistant');
        if (!node || node.status !== 'complete') return;
        if (!this.store.canReview(this.store.index()?.branches.get(node.branchId) ?? null)) return;
        this.ui.reviewDialog.set({ nodeId: node.id });
        break;
      }
      case '/':
        this.ui.focusComposer();
        break;
      case 'i':
        if (onTree) this.ui.toggleInspector();
        break;
      // Text size: plain keys, so Ctrl/Cmd +/-/0 stay the browser's zoom. `=` is `+` unshifted.
      case '+':
      case '=':
        if (onTree) this.textSize.increase();
        break;
      case '-':
        if (onTree) this.textSize.decrease();
        break;
      case '0':
        if (onTree) this.textSize.reset();
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
