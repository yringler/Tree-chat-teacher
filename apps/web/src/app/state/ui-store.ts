import { Injectable, signal } from '@angular/core';

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

/** An in-app link shown in a toast (e.g. "Add credit" → `/billing`). */
export interface ToastLink {
  label: string;
  path: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
  link?: ToastLink;
}

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

/** View state that is not part of the URL: panels, dialogs, toasts. */
@Injectable({ providedIn: 'root' })
export class UiStore {
  readonly drawerOpen = signal(false);
  readonly inspectorOpen = signal(readFlag(INSPECTOR_KEY));
  readonly shortcutsOpen = signal(false);
  readonly branchDialog = signal<BranchDialogState | null>(null);
  readonly branchSettingsOpen = signal(false);
  readonly treeSettingsOpen = signal(false);
  readonly shareDialogOpen = signal(false);
  readonly exportMenuOpen = signal(false);
  readonly textSizeMenuOpen = signal(false);
  /** Keys & credit dialog; `provider` preselects the provider to enter a key for. */
  readonly keysDialog = signal<{ provider: string | null } | null>(null);
  readonly settingsOpen = signal(false);
  readonly accountOpen = signal(false);
  /** Review dialog for one assistant message. */
  readonly reviewDialog = signal<{ nodeId: string } | null>(null);
  /**
   * Compare: Normal and Max answer `content` at the leaf of `branchId`, and
   * the user keeps one. The message stays in the composer until a pick commits.
   */
  readonly compareDialog = signal<{ branchId: string; content: string } | null>(null);
  readonly linkDialog = signal<LinkDialogState | null>(null);
  readonly linkPick = signal<LinkPickState | null>(null);
  readonly linkReturn = signal<LinkReturn | null>(null);
  /** Messages whose "N related" list is open (by node id). */
  readonly relatedOpen = signal<ReadonlySet<string>>(new Set());
  /** Text for the composer to insert; `seq` makes repeated inserts of the same text distinct. */
  readonly composerInsert = signal<{ seq: number; text: string } | null>(null);
  /**
   * A message that reached the server (its reply started): a composer still
   * holding exactly that text lets it go. Until then the text stays, so a
   * refused or failed send never loses it.
   */
  readonly composerSent = signal<{ seq: number; text: string } | null>(null);
  /** Outline items the user collapsed (by branch id). */
  readonly collapsed = signal<ReadonlySet<string>>(new Set());
  /** Bumped to ask the composer to take focus. */
  readonly composerFocus = signal(0);
  readonly toasts = signal<readonly Toast[]>([]);
  private toastSeq = 0;

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
    this.linkDialog.set(null);
    this.linkPick.set(null);
    this.linkReturn.set(null);
  }

  focusComposer(): void {
    this.composerFocus.update((n) => n + 1);
  }

  /** Appends `text` to the composer draft and focuses it. */
  insertIntoComposer(text: string): void {
    this.composerInsert.update((cur) => ({ seq: (cur?.seq ?? 0) + 1, text }));
  }

  markSent(text: string): void {
    this.composerSent.update((cur) => ({ seq: (cur?.seq ?? 0) + 1, text }));
  }

  anyDialogOpen(): boolean {
    return (
      this.branchDialog() !== null ||
      this.linkDialog() !== null ||
      this.branchSettingsOpen() ||
      this.treeSettingsOpen() ||
      this.shareDialogOpen() ||
      this.shortcutsOpen() ||
      this.keysDialog() !== null ||
      this.settingsOpen() ||
      this.accountOpen() ||
      this.reviewDialog() !== null ||
      this.compareDialog() !== null
    );
  }

  /** Escape: closes the top-most overlay. Returns true if something closed. */
  closeTop(): boolean {
    if (this.keysDialog()) {
      this.keysDialog.set(null);
      return true;
    }
    if (this.branchDialog()) {
      this.branchDialog.set(null);
      return true;
    }
    if (this.reviewDialog()) {
      this.reviewDialog.set(null);
      return true;
    }
    if (this.compareDialog()) {
      this.compareDialog.set(null);
      return true;
    }
    if (this.linkDialog()) {
      this.linkDialog.set(null);
      return true;
    }
    for (const s of [
      this.branchSettingsOpen,
      this.treeSettingsOpen,
      this.shareDialogOpen,
      this.shortcutsOpen,
      this.settingsOpen,
      this.accountOpen,
    ]) {
      if (s()) {
        s.set(false);
        return true;
      }
    }
    if (this.linkPick()) {
      this.linkPick.set(null);
      return true;
    }
    for (const s of [this.exportMenuOpen, this.textSizeMenuOpen]) {
      if (s()) {
        s.set(false);
        return true;
      }
    }
    if (this.drawerOpen()) {
      this.drawerOpen.set(false);
      return true;
    }
    return false;
  }

  notify(text: string, kind: Toast['kind'] = 'info', link?: ToastLink): void {
    const id = ++this.toastSeq;
    this.toasts.update((list) => [
      ...list.slice(-3),
      { id, kind, text, ...(link ? { link } : {}) },
    ]);
    setTimeout(() => this.dismiss(id), kind === 'error' ? 8000 : 3500);
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
