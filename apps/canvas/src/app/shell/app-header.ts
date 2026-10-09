import { ChangeDetectionStrategy, Component, ElementRef, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  AccountId,
  AuthService,
  DEMO_MODE,
  Icon,
  Logo,
  ModeSwitch,
  ToastStore,
} from '@tangent/web-shared';
import { BRAND, BRAND_SHORT, DEMO_EXIT_URL } from '../brand';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';

/** Brand, the Power / Learn / Canvas switch, the experimental mark, keys and the account menu. */
@Component({
  selector: 'app-header',
  imports: [RouterLink, Icon, Logo, ModeSwitch, AccountId],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="app-head">
      <a routerLink="/" class="brand" [attr.aria-label]="brand">
        <app-logo [size]="22" />
        <span aria-hidden="true"
          >{{ brandShort }}<span class="hide-narrow">{{ brandRest }}</span></span
        >
      </a>
      <app-mode-switch
        current="canvas"
        [treeId]="store.selectedTreeId()"
        [branchId]="store.selectedBranchId()"
      />
      <span
        class="badge badge-experimental"
        title="Canvas is experimental: the same conversations and keys as Power mode, a very different way of looking at them"
        >experimental</span
      >
      @if (store.account.me()?.devMode) {
        <span class="badge badge-warn" title="DEV_ALLOW_NO_AUTH is on">dev: auth disabled</span>
      }
      <span class="spacer"></span>
      @if (!demo) {
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          title="API keys (bring your own)"
          (click)="ui.dialogs.open({ kind: 'keys' })"
        >
          <app-icon name="key" [size]="15" />
          <span class="hide-narrow">Keys</span>
          @if (store.account.keyStatus()?.hasKey) {
            <span class="dot-key" aria-label="Your key is stored"></span>
          }
        </button>
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
            @if (store.account.me()?.email; as email) {
              <p class="menu-label muted small">{{ email }}</p>
            }
            @if (!demo && store.account.me()?.userId; as id) {
              <app-account-id class="menu-label" [userId]="id" [menu]="true" />
            }
            <a class="menu-item" role="menuitem" [href]="demo ? '/demo/' : '/'">
              Open in Power mode
            </a>
            <button type="button" class="menu-item" role="menuitem" (click)="signOut()">
              {{ demo ? 'Leave the demo' : 'Sign out' }}
            </button>
            @if (!demo && store.account.me()?.email) {
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
  protected readonly store = inject(CanvasStore);
  protected readonly ui = inject(UiStore);
  private readonly toast = inject(ToastStore);
  private readonly auth = inject(AuthService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly brand = BRAND;
  protected readonly brandShort = BRAND_SHORT;
  protected readonly brandRest = BRAND.startsWith(BRAND_SHORT)
    ? BRAND.slice(BRAND_SHORT.length)
    : '';
  protected readonly demo = inject(DEMO_MODE);

  protected onDocumentClick(e: MouseEvent): void {
    if (this.ui.menuOpen() && !this.host.nativeElement.contains(e.target as Node | null)) {
      this.ui.menuOpen.set(false);
    }
  }

  protected openDeleteAccount(): void {
    this.ui.menuOpen.set(false);
    this.ui.dialogs.open({ kind: 'delete-account' });
  }

  protected async signOut(): Promise<void> {
    this.ui.menuOpen.set(false);
    if (this.demo) {
      location.assign(DEMO_EXIT_URL);
      return;
    }
    try {
      await this.auth.signOut();
    } catch (err) {
      this.toast.notify(err instanceof Error ? err.message : String(err), 'error');
    }
  }
}
