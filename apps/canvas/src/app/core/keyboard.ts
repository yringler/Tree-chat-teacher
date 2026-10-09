import { inject, Injectable } from '@angular/core';
import { branchLeaf, type TreeIndex } from '@tangent/core/tree';
import { dispatchShortcut, type ShortcutHelp } from '@tangent/web-shared';
import { LayoutStore } from '../layout/layout-store';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';

export const SHORTCUTS: readonly ShortcutHelp[] = [
  { keys: ['Alt+↑', '['], label: 'Parent lane (at the fork)' },
  { keys: ['Alt+←', 'Alt+→'], label: 'Previous / next sibling lane' },
  { keys: ['Alt+↓', ']'], label: 'First child lane' },
  { keys: ['b'], label: 'Branch from the latest message of the selected lane' },
  { keys: ['c'], label: 'Fold / unfold the lanes below the selected one' },
  {
    keys: ['r'],
    label: 'Link the focused card (else the lane’s latest message) to another card',
  },
  { keys: ['l'], label: 'Toggle the lineage view' },
  { keys: ['f', '0'], label: 'Fit the whole tree / go to the selected lane' },
  { keys: ['+', '−'], label: 'Zoom in / out' },
  { keys: ['/'], label: 'Write in the selected lane' },
  { keys: ['?'], label: 'Show this help' },
  { keys: ['Esc'], label: 'Close dialogs' },
];

/** Global shortcuts (`dispatchShortcut`: not while typing, nor behind a dialog), on an open tree. */
@Injectable({ providedIn: 'root' })
export class Keyboard {
  private readonly store = inject(CanvasStore);
  private readonly ui = inject(UiStore);
  private readonly geo = inject(LayoutStore);

  /** On an open tree only, with its index and the selected lane. */
  private onTree(run: (idx: TreeIndex, selected: string | null) => void): () => boolean {
    return () => {
      const idx = this.store.index();
      if (!idx) return false;
      run(idx, this.store.selectedBranchId());
      return true;
    };
  }

  private readonly keys: Readonly<Record<string, () => unknown>> = {
    '[': this.onTree(() => this.store.navigate('parent')),
    ']': this.onTree(() => this.store.navigate('firstChild')),
    b: this.onTree((idx, selected) => {
      const leaf = selected ? branchLeaf(idx, selected) : null;
      if (leaf && leaf.status === 'complete')
        this.ui.dialogs.open({ kind: 'branch', fromNodeId: leaf.id, quote: null });
    }),
    r: this.onTree((idx, selected) => {
      // The focused card, else the selected lane's latest message.
      const focused = this.store.focusedNodeId();
      const from =
        focused !== null && idx.nodes.has(focused)
          ? focused
          : selected
            ? (branchLeaf(idx, selected)?.id ?? null)
            : null;
      if (from) this.ui.startLinkPick(from);
    }),
    c: this.onTree((idx, selected) => {
      if (selected && (idx.childBranches.get(selected)?.length ?? 0) > 0)
        this.ui.toggleCollapsed(selected);
    }),
    l: this.onTree(() => this.ui.lineage.update((v) => !v)),
    f: this.onTree(() => this.geo.fitAll()),
    '0': this.onTree((_idx, selected) => {
      if (selected) this.geo.centerOn(selected);
    }),
    '+': this.onTree(() => this.geo.zoomStep(1)),
    '=': this.onTree(() => this.geo.zoomStep(1)),
    '-': this.onTree(() => this.geo.zoomStep(-1)),
    _: this.onTree(() => this.geo.zoomStep(-1)),
    '/': this.onTree(() => this.ui.focusComposer()),
  };

  handle(e: KeyboardEvent): void {
    dispatchShortcut(e, {
      closeTop: () => this.ui.closeTop(),
      dialogOpen: () => this.ui.dialogs.anyOpen(),
      toggleHelp: () => this.ui.dialogs.toggle({ kind: 'help' }),
      navigate: (step) => this.store.navigate(step),
      keys: this.keys,
    });
  }
}
