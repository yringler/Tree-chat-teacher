import { ChangeDetectionStrategy, Component, ElementRef, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  AccountId,
  AuthService,
  DEMO_MODE,
  Icon,
  Logo,
  ModeSwitch,
  SidebarToggle,
  ToastStore,
} from '@tangent/web-shared';
import { BRAND, BRAND_SHORT } from '../brand';
import { DEMO_EXIT_URL } from '../demo/demo-mode';
import { AccountStore } from '../state/account-store';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { PaidBy } from './paid-by';
import { LearnFunding } from '../state/learn-funding';

/**
 * The sidebar's button (narrow screens), brand, the Power / Learn switch, what replies are paid by (own key, credit
 * or the open pool: a button that opens "How replies are paid for") and
 * the account menu.
 */
@Component({
  selector: 'app-header',
  imports: [RouterLink, Icon, Logo, ModeSwitch, AccountId, PaidBy, SidebarToggle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="app-head">
      <app-sidebar-toggle />
      <a routerLink="/" class="brand" [attr.aria-label]="brand">
        <app-logo [size]="22" />
        <span class="brand-word" aria-hidden="true"
          >{{ brandShort }}<span class="hide-narrow">{{ brandRest }}</span></span
        >
      </a>
      <app-mode-switch
        current="simple"
        [treeId]="lessons.selectedTreeId()"
        [branchId]="lessons.selectedBranchId()"
      />
      <span class="spacer"></span>
      <app-paid-by variant="header" />
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
            @if (!demo && account.me()?.userId; as id) {
              <app-account-id class="menu-label" [userId]="id" [menu]="true" />
            }
            @if (!demo) {
              <button type="button" class="menu-item" role="menuitem" (click)="openAccess()">
                How replies are paid for
              </button>
            }
            @if (funding.creditOffered() || funding.membership()?.required || funding.poolOn()) {
              <a routerLink="/billing" class="menu-item" role="menuitem" (click)="close()">
                {{ funding.creditOffered() ? 'Billing and credit' : 'Billing' }}
              </a>
            }
            @if (!demo) {
              <button type="button" class="menu-item" role="menuitem" (click)="openPasskeys()">
                Manage passkeys
              </button>
            }
            <button type="button" class="menu-item" role="menuitem" (click)="signOut()">
              {{ demo ? 'Leave the demo' : 'Sign out' }}
            </button>
            @if (!demo && account.me()?.email) {
              <button
                type="button"
                class="menu-item menu-item-danger"
                role="menuitem"
                (click)="openDeleteAccount()"
              >
                Delete account
              </button>
            }
            <a href="/privacy" target="_blank" rel="noopener" class="menu-item" role="menuitem">
              Privacy policy
            </a>
            <a href="/terms" target="_blank" rel="noopener" class="menu-item" role="menuitem">
              Terms of service
            </a>
          </div>
        }
      </div>
    </header>
  `,
  host: { '(document:click)': 'onDocumentClick($event)' },
})
export class AppHeader {
  protected readonly account = inject(AccountStore);
  protected readonly funding = inject(LearnFunding);
  protected readonly lessons = inject(LessonStore);
  protected readonly ui = inject(UiStore);
  private readonly toast = inject(ToastStore);
  private readonly auth = inject(AuthService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly brand = BRAND;
  protected readonly brandShort = BRAND_SHORT;
  /** The rest of the brand after its first word, e.g. " Learn". */
  protected readonly brandRest = BRAND.startsWith(BRAND_SHORT)
    ? BRAND.slice(BRAND_SHORT.length)
    : '';
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
    this.ui.dialogs.open({ kind: 'access' });
  }

  protected openPasskeys(): void {
    this.close();
    this.ui.dialogs.open({ kind: 'passkeys' });
  }

  protected openDeleteAccount(): void {
    this.close();
    this.ui.dialogs.open({ kind: 'delete-account' });
  }

  protected async signOut(): Promise<void> {
    this.close();
    if (this.demo) {
      // Nobody is signed in: leave the demo for the landing page.
      location.assign(DEMO_EXIT_URL);
      return;
    }
    this.lessons.forgetUnsent();
    try {
      await this.auth.signOut();
    } catch (err) {
      this.toast.notify(err instanceof Error ? err.message : String(err), 'error');
    }
  }
}
