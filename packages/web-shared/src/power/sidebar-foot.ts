import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { DEMO_MODE } from '../core/demo';
import { SidebarState } from '../nav/sidebar-host';
import { Icon } from '../ui/icon';
import { ImportButton } from './import-button';
import { PowerConversationStore } from './power-conversation-store';

/**
 * The account entries at the foot of power's and Canvas's sidebar: Shares,
 * Keys, Billing, Admin, Import backup, then whatever the app projects (its
 * Settings, its help), then Account, or Leave the demo in the demo. The app
 * puts it inside its `sidebarFoot` element and opens its own dialogs on
 * `keys` and `account`.
 */
@Component({
  selector: 'app-power-sidebar-foot',
  imports: [RouterLink, RouterLinkActive, Icon, ImportButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- The demo has no shares, keys, billing or account: nothing is published or signed in. -->
    @if (!demo) {
      @if (account.me()?.sharing) {
        @if (ownPages()) {
          <a
            routerLink="/shares"
            routerLinkActive="is-current"
            class="btn btn-ghost"
            (click)="close()"
          >
            <app-icon name="share" /> Shares
          </a>
        } @else {
          <a href="/shares" class="btn btn-ghost"><app-icon name="share" /> Shares</a>
        }
      }
      <button
        type="button"
        class="btn btn-ghost"
        [attr.title]="keyTitle()"
        (click)="keys.emit(); close()"
      >
        <app-icon name="key" />
        {{ account.me()?.builtInCredit ? 'Keys & credit' : 'Keys' }}
        @if (account.keyStatus()?.hasKey) {
          <span class="dot-key" aria-label="Your key is stored"></span>
        }
      </button>
      @if (ownPages()) {
        <a
          routerLink="/billing"
          routerLinkActive="is-current"
          class="btn btn-ghost"
          (click)="close()"
        >
          <app-icon name="creditCard" /> Billing
        </a>
      } @else {
        <a href="/billing" class="btn btn-ghost"><app-icon name="creditCard" /> Billing</a>
      }
      <!-- The operator's accounts only (ADMIN_USER_IDS); a separate app, so a full page load. -->
      @if (account.me()?.isAdmin) {
        <a href="/admin/" class="btn btn-ghost"><app-icon name="lock" /> Admin</a>
      }
    }
    <app-import-button />
    <ng-content />
    @if (demo) {
      <a class="btn btn-ghost" [href]="exitUrl()"><app-icon name="user" /> Leave the demo</a>
    } @else {
      <button
        type="button"
        class="btn btn-ghost"
        [attr.title]="account.me()?.email ?? 'Account'"
        (click)="openAccount.emit(); close()"
      >
        <app-icon name="user" /> Account
      </button>
    }
  `,
  host: { style: 'display: contents' },
})
export class PowerSidebarFoot {
  protected readonly account = inject(PowerConversationStore).account;
  protected readonly demo = inject(DEMO_MODE);
  private readonly sidebar = inject(SidebarState);
  /**
   * Shares and Billing are routes of this app (power). Elsewhere (Canvas)
   * they are power's pages, so a full page load.
   */
  readonly ownPages = input(false);
  /** Where "Leave the demo" goes. */
  readonly exitUrl = input.required<string>();
  /** Keys (& credit): the app opens its keys dialog. */
  readonly keys = output();
  /** Account: the app opens the account dialog. */
  readonly openAccount = output();

  protected readonly keyTitle = computed(() => {
    const ids = this.account.keyStatus()?.providers ?? [];
    if (ids.length === 0) return 'API keys: none of your own stored';
    const labels = ids.map((id) => this.account.providerMap().get(id)?.label ?? id);
    return `API keys: yours for ${labels.join(', ')}`;
  });

  protected close(): void {
    this.sidebar.drawerOpen.set(false);
  }
}
