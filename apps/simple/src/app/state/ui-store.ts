import { inject, Injectable, signal } from '@angular/core';
import { Overlays, SidebarState } from '@tangent/web-shared';

/**
 * A dialog of Learn, with what it was opened with. `access`: "How replies are
 * paid for" (own OpenRouter key, credit or the pool); `pool-verify`: the
 * human check before a first pool message (PoolFirstUseDialog); `connect`:
 * the Connect sheet (ConnectDialog) for the message a connection is made
 * from; `compare`: the Compare sheet (CompareDialog), the question to ask
 * Normal and Max in `branchId` (it stays in the composer meanwhile);
 * `shortcuts`: the keyboard shortcuts.
 */
export type Dialog =
  | { kind: 'passkeys' }
  | { kind: 'delete-account' }
  | { kind: 'access' }
  | { kind: 'pool-verify' }
  | { kind: 'connect'; sourceNodeId: string }
  | { kind: 'compare'; branchId: string; content: string }
  | { kind: 'shortcuts' };

/** View state that is not part of the URL: the account menu and dialogs. */
@Injectable({ providedIn: 'root' })
export class UiStore {
  private readonly sidebar = inject(SidebarState);
  readonly menuOpen = signal(false);
  /** The open dialogs (`Dialog`), top-most last. */
  readonly dialogs = new Overlays<Dialog>();

  /**
   * Escape: closes the top-most dialog, else the account menu, else the
   * sidebar's drawer. Returns true if something closed.
   */
  closeTop(): boolean {
    if (this.dialogs.closeTop()) return true;
    for (const s of [this.menuOpen, this.sidebar.drawerOpen]) {
      if (s()) {
        s.set(false);
        return true;
      }
    }
    return false;
  }
}
