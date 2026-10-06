import { computed, Injectable, signal } from '@angular/core';

/** A link shown in a toast; `href` is a full page load (e.g. the power app's `/billing`). */
export interface ToastLink {
  label: string;
  href: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
  link?: ToastLink;
}

/** The "Branch from here" dialog: one or many variants off one message. */
export interface BranchDialogState {
  fromNodeId: string;
  /** Text selected in the message, offered as the anchor quote. */
  quote: string | null;
  /**
   * The first message, already written ("Ask your own" under a reply, via its
   * gear): sent to every new lane, in place of the dialog's own field.
   */
  message?: string;
  /** Called once the lanes exist (e.g. to clear the field the message came from). */
  onCreated?: () => void;
}

/** The branch settings dialog (title, context mode, model, private). */
export interface BranchSettingsState {
  branchId: string;
}

const EXPERIMENTAL_KEY = 'tangent.canvas.experimental-ack';

function storedAck(): boolean {
  try {
    return localStorage.getItem(EXPERIMENTAL_KEY) === '1';
  } catch {
    return false;
  }
}

/** View state that is not part of the URL: toasts, dialogs, the lineage toggle, collapsed lanes. */
@Injectable({ providedIn: 'root' })
export class UiStore {
  readonly toasts = signal<readonly Toast[]>([]);
  readonly menuOpen = signal(false);
  readonly keysOpen = signal(false);
  readonly branchDialog = signal<BranchDialogState | null>(null);
  readonly branchSettings = signal<BranchSettingsState | null>(null);
  readonly helpOpen = signal(false);
  readonly deleteAccountOpen = signal(false);
  /** The "experimental" notice until it is dismissed (remembered in this browser). */
  readonly experimentalAck = signal(storedAck());
  /**
   * Lineage view: the messages the model would see for the selected lane are
   * lit, every other message dims. Off, every card reads the same.
   */
  readonly lineage = signal(true);
  /** Lanes whose subtree is folded into a capsule. */
  readonly collapsed = signal<ReadonlySet<string>>(new Set());
  /** Bumped to ask the selected lane's composer to take focus. */
  readonly composerFocus = signal(0);
  private toastSeq = 0;

  readonly anyDialogOpen = computed(
    () =>
      this.keysOpen() ||
      this.branchDialog() !== null ||
      this.branchSettings() !== null ||
      this.helpOpen() ||
      this.deleteAccountOpen(),
  );

  notify(text: string, kind: Toast['kind'] = 'info', link?: ToastLink): void {
    const id = ++this.toastSeq;
    this.toasts.update((list) => [
      ...list.slice(-2),
      { id, kind, text, ...(link ? { link } : {}) },
    ]);
    setTimeout(() => this.dismiss(id), kind === 'error' ? 8000 : 3500);
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  focusComposer(): void {
    this.composerFocus.update((n) => n + 1);
  }

  acknowledgeExperimental(): void {
    this.experimentalAck.set(true);
    try {
      localStorage.setItem(EXPERIMENTAL_KEY, '1');
    } catch {
      // Storage unavailable: the notice comes back next time.
    }
  }

  toggleCollapsed(branchId: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (next.has(branchId)) next.delete(branchId);
      else next.add(branchId);
      return next;
    });
  }

  /** Unfolds every lane on the way to `branchIds` (so a selected lane is never hidden). */
  expand(branchIds: Iterable<string>): void {
    const set = this.collapsed();
    const wanted = [...branchIds].filter((id) => set.has(id));
    if (wanted.length === 0) return;
    this.collapsed.update((cur) => {
      const next = new Set(cur);
      for (const id of wanted) next.delete(id);
      return next;
    });
  }

  /** Escape: closes the top-most overlay. Returns true if something closed. */
  closeTop(): boolean {
    if (this.deleteAccountOpen()) {
      this.deleteAccountOpen.set(false);
      return true;
    }
    if (this.helpOpen()) {
      this.helpOpen.set(false);
      return true;
    }
    if (this.branchDialog()) {
      this.branchDialog.set(null);
      return true;
    }
    if (this.branchSettings()) {
      this.branchSettings.set(null);
      return true;
    }
    if (this.keysOpen()) {
      this.keysOpen.set(false);
      return true;
    }
    if (this.menuOpen()) {
      this.menuOpen.set(false);
      return true;
    }
    return false;
  }
}
