import { inject, Injectable } from '@angular/core';
import { branchLeaf } from '@tangent/core/tree';
import { LayoutStore } from '../layout/layout-store';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';

export interface ShortcutHelp {
  keys: string[];
  label: string;
}

export const SHORTCUTS: readonly ShortcutHelp[] = [
  { keys: ['Alt+↑', '['], label: 'Parent lane (at the fork)' },
  { keys: ['Alt+←', 'Alt+→'], label: 'Previous / next sibling lane' },
  { keys: ['Alt+↓', ']'], label: 'First child lane' },
  { keys: ['b'], label: 'Branch from the latest message of the selected lane' },
  { keys: ['c'], label: 'Fold / unfold the lanes below the selected one' },
  { keys: ['l'], label: 'Toggle the lineage view' },
  { keys: ['f', '0'], label: 'Fit the whole tree / go to the selected lane' },
  { keys: ['+', '−'], label: 'Zoom in / out' },
  { keys: ['/'], label: 'Write in the selected lane' },
  { keys: ['?'], label: 'Show this help' },
  { keys: ['Esc'], label: 'Close dialogs' },
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
  private readonly store = inject(CanvasStore);
  private readonly ui = inject(UiStore);
  private readonly geo = inject(LayoutStore);

  handle(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === 'Escape') {
      if (this.ui.closeTop()) e.preventDefault();
      else if (isTyping(e.target) && e.target instanceof HTMLElement) e.target.blur();
      return;
    }
    if (isTyping(e.target) || e.ctrlKey || e.metaKey) return;
    if (e.key === '?') {
      this.ui.helpOpen.update((v) => !v);
      e.preventDefault();
      return;
    }
    if (this.ui.anyDialogOpen()) return;
    const idx = this.store.index();
    if (!idx) return;

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
      if (dir && this.store.navigate(dir)) e.preventDefault();
      return;
    }

    const selected = this.store.selectedBranchId();
    switch (e.key) {
      case '[':
        this.store.navigate('parent');
        break;
      case ']':
        this.store.navigate('firstChild');
        break;
      case 'b': {
        const leaf = selected ? branchLeaf(idx, selected) : null;
        if (leaf && leaf.status === 'complete')
          this.ui.branchDialog.set({ fromNodeId: leaf.id, quote: null });
        break;
      }
      case 'c':
        if (selected && (idx.childBranches.get(selected)?.length ?? 0) > 0)
          this.ui.toggleCollapsed(selected);
        break;
      case 'l':
        this.ui.lineage.update((v) => !v);
        break;
      case 'f':
        this.geo.fitAll();
        break;
      case '0':
        if (selected) this.geo.centerOn(selected);
        break;
      case '+':
      case '=':
        this.geo.zoomStep(1);
        break;
      case '-':
      case '_':
        this.geo.zoomStep(-1);
        break;
      case '/':
        this.ui.focusComposer();
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
