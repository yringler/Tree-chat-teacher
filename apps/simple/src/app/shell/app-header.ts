import { ChangeDetectionStrategy, Component, ElementRef, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService, Icon } from '@tangent/web-shared';
import { BRAND } from '../brand';
import { AccountStore } from '../state/account-store';
import { UiStore } from '../state/ui-store';

/** Brand, credit balance (links to billing) and the account menu. */
@Component({
  selector: 'app-header',
  imports: [RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="app-head">
      <a routerLink="/" class="brand"><app-icon name="tree" [size]="20" /> {{ brand }}</a>
      <span class="spacer"></span>
      @if (account.balanceLabel(); as balance) {
        <a
          routerLink="/billing"
          class="balance-pill"
          [class.balance-low]="account.lowBalance()"
          [attr.aria-label]="'Credit: ' + balance + '. Open billing'"
          title="Credit left · Billing"
        >
          {{ balance }}
        </a>
      }
      <div class="menu-anchor">
        <button
          type="button"
          class="icon-btn"
          aria-label="Account"
          aria-haspopup="menu"
          aria-controls="account-menu"
          [attr.aria-expanded]="ui.menuOpen()"
          (click)="ui.menuOpen.set(!ui.menuOpen())"
        >
          <app-icon name="user" [size]="18" />
        </button>
        @if (ui.menuOpen()) {
          <div class="menu" id="account-menu" role="menu">
            @if (account.me()?.email; as email) {
              <p class="menu-label muted small">{{ email }}</p>
            }
            <a routerLink="/billing" class="menu-item" role="menuitem" (click)="close()">
              Billing and credit
            </a>
            <button type="button" class="menu-item" role="menuitem" (click)="openPasskeys()">
              Manage passkeys
            </button>
            <button type="button" class="menu-item" role="menuitem" (click)="signOut()">
              Sign out
            </button>
          </div>
        }
      </div>
    </header>
  `,
  host: { '(document:click)': 'onDocumentClick($event)' },
})
export class AppHeader {
  protected readonly account = inject(AccountStore);
  protected readonly ui = inject(UiStore);
  private readonly auth = inject(AuthService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly brand = BRAND;

  protected onDocumentClick(e: MouseEvent): void {
    if (this.ui.menuOpen() && !this.host.nativeElement.contains(e.target as Node | null)) {
      this.close();
    }
  }

  protected close(): void {
    this.ui.menuOpen.set(false);
  }

  protected openPasskeys(): void {
    this.close();
    this.ui.passkeysOpen.set(true);
  }

  protected async signOut(): Promise<void> {
    this.close();
    try {
      await this.auth.signOut();
    } catch (err) {
      this.ui.notify(err instanceof Error ? err.message : String(err), 'error');
    }
  }
}
