import { ChangeDetectionStrategy, Component, ElementRef, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService, Icon, ModeSwitch } from '@tangent/web-shared';
import { BRAND } from '../brand';
import { DEMO_EXIT_URL, DEMO_MODE } from '../demo/demo-mode';
import { AccountStore } from '../state/account-store';
import { UiStore } from '../state/ui-store';

/**
 * Brand, the Power / Learn switch, how replies are paid for (the credit
 * balance, linking to billing, or "Your key") and the account menu.
 */
@Component({
  selector: 'app-header',
  imports: [RouterLink, Icon, ModeSwitch],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="app-head">
      <a routerLink="/" class="brand"><app-icon name="tree" [size]="20" /> {{ brand }}</a>
      @if (!demo) {
        <app-mode-switch current="simple" />
      }
      <span class="spacer"></span>
      @if (account.needsKey()) {
        <button type="button" class="key-pill balance-low" (click)="ui.accessOpen.set(true)">
          Add your key
        </button>
      } @else if (account.payment.payment() === 'own-key' && account.keyStatus()) {
        <button
          type="button"
          class="key-pill"
          title="Replies run on your own OpenRouter key"
          (click)="ui.accessOpen.set(true)"
        >
          Your key
        </button>
      } @else if (account.balanceLabel(); as balance) {
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
            @if (!demo) {
              <button type="button" class="menu-item" role="menuitem" (click)="openAccess()">
                How replies are paid for
              </button>
            }
            @if (account.payment.paidCredit()) {
              <a routerLink="/billing" class="menu-item" role="menuitem" (click)="close()">
                Billing and credit
              </a>
            }
            @if (!demo) {
              <button type="button" class="menu-item" role="menuitem" (click)="openPasskeys()">
                Manage passkeys
              </button>
            }
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
  protected readonly demo = inject(DEMO_MODE);

  protected onDocumentClick(e: MouseEvent): void {
    if (this.ui.menuOpen() && !this.host.nativeElement.contains(e.target as Node | null)) {
      this.close();
    }
  }

  protected close(): void {
    this.ui.menuOpen.set(false);
  }

  protected openAccess(): void {
    this.close();
    this.ui.accessOpen.set(true);
  }

  protected openPasskeys(): void {
    this.close();
    this.ui.passkeysOpen.set(true);
  }

  protected async signOut(): Promise<void> {
    this.close();
    if (this.demo) {
      // Nobody is signed in: leave the demo for the landing page.
      location.assign(DEMO_EXIT_URL);
      return;
    }
    try {
      await this.auth.signOut();
    } catch (err) {
      this.ui.notify(err instanceof Error ? err.message : String(err), 'error');
    }
  }
}
