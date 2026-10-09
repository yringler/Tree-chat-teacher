import { Injectable, signal } from '@angular/core';
import { Overlays } from '@tangent/web-shared';

export interface BranchDialogState {
  fromNodeId: string;
  /** Text the user had selected inside the source message, if any. */
  quote: string | null;
  /**
   * The first message, already written ("Ask your own" under a reply, via its
   * gear): the dialog sends it and asks for no starting message of its own.
   */
  message?: string;
  /** Called once the branch exists (e.g. to clear the field the message came from). */
  onCreated?: () => void;
}

/** "Link…" on a message: the dialog that picks the other end. */
export interface LinkDialogState {
  fromNodeId: string;
}

/**
 * "Pick on the page instead": the next "Link here" clicked links `fromNodeId`
 * to that message. Survives branch navigation; ends with the tree.
 */
export interface LinkPickState {
  fromNodeId: string;
}

/** Where a link chip was opened from: the header's "Back to ‘…’" pill returns there. */
export interface LinkReturn {
  branchId: string;
  /** The message whose chip was opened. */
  focusNodeId: string | null;
  /** The branch's title, for the pill. */
  label: string;
  /** Where the chip went: the pill shows while the view is still there. */
  toBranchId: string;
  toNodeId: string;
}

/**
 * A dialog of the power app, with what it was opened with. `keys`: Keys &
 * credit, `provider` preselecting the provider to enter a key for; `review`:
 * the review of one assistant message; `compare`: Normal and Max answer
 * `content` at the leaf of `branchId`, and the user keeps one (the message
 * stays in the composer until a pick commits).
 */
export type Dialog =
  | ({ kind: 'branch' } & BranchDialogState)
  | { kind: 'branch-settings' }
  | { kind: 'tree-settings' }
  | { kind: 'share' }
  | { kind: 'shortcuts' }
  | { kind: 'keys'; provider: string | null }
  | { kind: 'settings' }
  | { kind: 'account' }
  | { kind: 'review'; nodeId: string }
  | { kind: 'compare'; branchId: string; content: string }
  | ({ kind: 'link' } & LinkDialogState);

const INSPECTOR_KEY = 'tangent.inspectorOpen';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Storage unavailable.
  }
}

/** View state that is not part of the URL: panels and dialogs. */
@Injectable({ providedIn: 'root' })
export class UiStore {
  readonly drawerOpen = signal(false);
  readonly inspectorOpen = signal(readFlag(INSPECTOR_KEY));
  readonly exportMenuOpen = signal(false);
  readonly textSizeMenuOpen = signal(false);
  /** The open dialogs (`Dialog`), top-most last. */
  readonly dialogs = new Overlays<Dialog>();
  readonly linkPick = signal<LinkPickState | null>(null);
  readonly linkReturn = signal<LinkReturn | null>(null);
  /** Messages whose "N related" list is open (by node id). */
  readonly relatedOpen = signal<ReadonlySet<string>>(new Set());
  /** Outline items the user collapsed (by branch id). */
  readonly collapsed = signal<ReadonlySet<string>>(new Set());

  toggleInspector(): void {
    const next = !this.inspectorOpen();
    this.inspectorOpen.set(next);
    writeFlag(INSPECTOR_KEY, next);
  }

  toggleCollapsed(branchId: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (next.has(branchId)) next.delete(branchId);
      else next.add(branchId);
      return next;
    });
  }

  setRelatedOpen(nodeIds: readonly string[], open: boolean): void {
    this.relatedOpen.update((set) => {
      const next = new Set(set);
      for (const id of nodeIds) {
        if (open) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  /** Forgets the link dialog, pick mode and the return pill (another tree opened). */
  clearLinkState(): void {
    this.dialogs.close('link');
    this.linkPick.set(null);
    this.linkReturn.set(null);
  }

  /**
   * Escape: closes the top-most overlay (a dialog, then pick mode, a menu,
   * the drawer). Returns true if something closed.
   */
  closeTop(): boolean {
    if (this.dialogs.closeTop()) return true;
    if (this.linkPick()) {
      this.linkPick.set(null);
      return true;
    }
    for (const s of [this.exportMenuOpen, this.textSizeMenuOpen, this.drawerOpen]) {
      if (s()) {
        s.set(false);
        return true;
      }
    }
    return false;
  }
}
