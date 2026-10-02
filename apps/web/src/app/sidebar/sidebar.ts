import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { DEMO_MODE, Icon, ModeSwitch } from '@tangent/web-shared';
import { ImportButton } from '../ui/import-button';
import { OutlineItem } from './outline-item';

@Component({
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive, Icon, ImportButton, ModeSwitch, OutlineItem],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sidebar-head">
      <a routerLink="/" class="brand" (click)="ui.drawerOpen.set(false)">
        <app-icon name="tree" [size]="18" /> Tangent
      </a>
      <app-mode-switch current="power" />
      @if (store.me()?.devMode) {
        <span class="badge badge-warn" title="DEV_ALLOW_NO_AUTH is on">dev: auth disabled</span>
      }
      <button
        type="button"
        class="icon-btn only-narrow"
        aria-label="Close menu"
        (click)="ui.drawerOpen.set(false)"
      >
        <app-icon name="x" />
      </button>
    </div>

    <a routerLink="/" class="btn btn-primary new-btn" (click)="ui.drawerOpen.set(false)">
      <app-icon name="plus" /> New conversation
    </a>

    <nav class="tree-list" aria-label="Conversations">
      @if (store.treesLoaded() && store.trees().length === 0) {
        <p class="muted small pad">No conversations yet.</p>
      }
      <ul>
        @for (t of store.trees(); track t.id) {
          @let current = t.id === store.selectedTreeId();
          <li>
            <a
              class="tree-link"
              [routerLink]="['/t', t.id]"
              [class.is-current]="current"
              [attr.aria-current]="current ? 'true' : null"
              (click)="ui.drawerOpen.set(false)"
            >
              <span class="tree-title">{{
                current ? (store.detail()?.tree?.title ?? t.title) : t.title
              }}</span>
              <span
                class="count"
                [attr.title]="t.branchCount + ' branches, ' + t.messageCount + ' messages'"
              >
                {{ t.branchCount }}·{{ t.messageCount }}
              </span>
            </a>
            @if (current) {
              @if (store.outline(); as root) {
                <ul class="outline" role="tree" aria-label="Branches">
                  <app-outline-item [item]="root" />
                </ul>
              } @else if (store.detailLoading()) {
                <p class="muted small pad">Loading…</p>
              }
            }
          </li>
        }
      </ul>
    </nav>

    <div class="sidebar-foot">
      <!-- The demo has no shares, keys or account: nothing is published or signed in. -->
      @if (!demo) {
        <a
          routerLink="/shares"
          routerLinkActive="is-current"
          class="btn btn-ghost"
          (click)="ui.drawerOpen.set(false)"
        >
          <app-icon name="share" /> Shares
        </a>
        <button
          type="button"
          class="btn btn-ghost"
          [attr.title]="keyTitle()"
          (click)="ui.keysDialog.set({ provider: null }); ui.drawerOpen.set(false)"
        >
          <app-icon name="key" /> Keys
          @if (store.keyStatus()?.hasKey) {
            <span class="dot-key" aria-label="Your key is stored"></span>
          }
        </button>
      }
      <app-import-button />
      <button
        type="button"
        class="btn btn-ghost"
        (click)="ui.settingsOpen.set(true); ui.drawerOpen.set(false)"
      >
        <app-icon name="gear" /> Settings
      </button>
      @if (demo) {
        <a class="btn btn-ghost" [href]="exitUrl"><app-icon name="user" /> Leave the demo</a>
      } @else {
        <button
          type="button"
          class="btn btn-ghost"
          [attr.title]="store.me()?.email ?? 'Account'"
          (click)="ui.accountOpen.set(true); ui.drawerOpen.set(false)"
        >
          <app-icon name="user" /> Account
        </button>
      }
    </div>
  `,
  host: { class: 'sidebar-inner' },
})
export class Sidebar {
  protected readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);
  protected readonly demo = inject(DEMO_MODE);
  /** The public landing page. */
  protected readonly exitUrl = '/welcome';
  protected readonly keyTitle = computed(() => {
    const ids = this.store.keyStatus()?.providers ?? [];
    if (ids.length === 0) return 'API keys: none of your own stored';
    const labels = ids.map((id) => this.store.providerMap().get(id)?.label ?? id);
    return `API keys: yours for ${labels.join(', ')}`;
  });
}
