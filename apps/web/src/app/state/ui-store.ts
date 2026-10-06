import { Injectable, signal } from '@angular/core';

export interface BranchDialogState {
  fromNodeId: string;
  /** Text the user had selected inside the source message, if any. */
  quote: string | null;
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
  /** Text for the composer to insert; `seq` makes repeated inserts of the same text distinct. */
  readonly composerInsert = signal<{ seq: number; text: string } | null>(null);
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

  focusComposer(): void {
    this.composerFocus.update((n) => n + 1);
  }

  /** Appends `text` to the composer draft and focuses it. */
  insertIntoComposer(text: string): void {
    this.composerInsert.update((cur) => ({ seq: (cur?.seq ?? 0) + 1, text }));
  }

  anyDialogOpen(): boolean {
    return (
      this.branchDialog() !== null ||
      this.branchSettingsOpen() ||
      this.treeSettingsOpen() ||
      this.shareDialogOpen() ||
      this.shortcutsOpen() ||
      this.keysDialog() !== null ||
      this.settingsOpen() ||
      this.accountOpen() ||
      this.reviewDialog() !== null
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
