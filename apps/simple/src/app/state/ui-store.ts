import { Injectable, signal } from '@angular/core';
import { Overlays } from '@tangent/web-shared';

/**
 * A dialog of Learn, with what it was opened with. `access`: "How replies are
 * paid for" (own OpenRouter key, credit or the pool); `pool-verify`: the
 * human check before a first pool message (PoolFirstUseDialog); `connect`:
 * the Connect sheet (ConnectDialog) for the message a connection is made
 * from; `compare`: the Compare sheet (CompareDialog), the question to ask
 * Normal and Max in `branchId` (it stays in the composer meanwhile).
 */
export type Dialog =
  | { kind: 'passkeys' }
  | { kind: 'delete-account' }
  | { kind: 'access' }
  | { kind: 'pool-verify' }
  | { kind: 'connect'; sourceNodeId: string }
  | { kind: 'compare'; branchId: string; content: string };

/** View state that is not part of the URL: the account menu, dialogs, composer focus requests. */
@Injectable({ providedIn: 'root' })
export class UiStore {
  readonly menuOpen = signal(false);
  /** The open dialogs (`Dialog`), top-most last. */
  readonly dialogs = new Overlays<Dialog>();
  /** Bumped to ask the composer to take focus. */
  readonly composerFocus = signal(0);
  /**
   * A message that reached the server (its reply started): a composer still
   * holding exactly that text lets it go. Until then the text stays, so a
   * refused or failed send never loses it.
   */
  readonly composerSent = signal<{ seq: number; text: string } | null>(null);

  markSent(text: string): void {
    this.composerSent.update((cur) => ({ seq: (cur?.seq ?? 0) + 1, text }));
  }

  focusComposer(): void {
    this.composerFocus.update((n) => n + 1);
  }

  /** Escape: closes the top-most dialog, else the account menu. Returns true if something closed. */
  closeTop(): boolean {
    if (this.dialogs.closeTop()) return true;
    if (this.menuOpen()) {
      this.menuOpen.set(false);
      return true;
    }
    return false;
  }
}
