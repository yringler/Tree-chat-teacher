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
  /** Bumped to ask the composer to take focus. */
  readonly composerFocus = signal(0);
  private toastSeq = 0;

  notify(text: string, kind: Toast['kind'] = 'info'): void {
    const id = ++this.toastSeq;
    this.toasts.update((list) => [...list.slice(-2), { id, kind, text }]);
    setTimeout(() => this.dismiss(id), kind === 'error' ? 8000 : 3500);
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
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
