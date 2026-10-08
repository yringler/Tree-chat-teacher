import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

/** View state that is not part of the URL: toasts, the account menu, dialogs, composer focus requests. */
@Injectable({ providedIn: 'root' })
export class UiStore {
  readonly toasts = signal<readonly Toast[]>([]);
  readonly menuOpen = signal(false);
  readonly passkeysOpen = signal(false);
  readonly deleteAccountOpen = signal(false);
  /** The "How replies are paid for" dialog (own OpenRouter key, credit or the pool). */
  readonly accessOpen = signal(false);
  /** The human check before a first pool message (PoolFirstUseDialog). */
  readonly poolVerifyOpen = signal(false);
  /** The "Connect" sheet (ConnectDialog): the message a connection is made from; null = closed. */
  readonly linkDialog = signal<string | null>(null);
  /**
   * The Compare sheet (CompareDialog): the question to ask Normal and Max in
   * `branchId`; null = closed. The question stays in the composer meanwhile.
   */
  readonly compare = signal<{ branchId: string; content: string } | null>(null);
  /** Bumped to ask the composer to take focus. */
  readonly composerFocus = signal(0);
  /**
   * A message that reached the server (its reply started): a composer still
   * holding exactly that text lets it go. Until then the text stays, so a
   * refused or failed send never loses it.
   */
  readonly composerSent = signal<{ seq: number; text: string } | null>(null);
  private toastSeq = 0;

  notify(text: string, kind: Toast['kind'] = 'info'): void {
    const id = ++this.toastSeq;
    this.toasts.update((list) => [...list.slice(-2), { id, kind, text }]);
    setTimeout(() => this.dismiss(id), kind === 'error' ? 8000 : 3500);
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  markSent(text: string): void {
    this.composerSent.update((cur) => ({ seq: (cur?.seq ?? 0) + 1, text }));
  }

  focusComposer(): void {
    this.composerFocus.update((n) => n + 1);
  }

  /** Escape: closes the top-most overlay. Returns true if something closed. */
  closeTop(): boolean {
    if (this.deleteAccountOpen()) {
      this.deleteAccountOpen.set(false);
      return true;
    }
    if (this.passkeysOpen()) {
      this.passkeysOpen.set(false);
      return true;
    }
    if (this.poolVerifyOpen()) {
      this.poolVerifyOpen.set(false);
      return true;
    }
    if (this.compare() !== null) {
      this.compare.set(null);
      return true;
    }
    if (this.linkDialog() !== null) {
      this.linkDialog.set(null);
      return true;
    }
    if (this.accessOpen()) {
      this.accessOpen.set(false);
      return true;
    }
    if (this.menuOpen()) {
      this.menuOpen.set(false);
      return true;
    }
    return false;
  }
}
