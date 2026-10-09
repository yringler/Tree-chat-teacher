import { ChangeDetectionStrategy, Component, computed, forwardRef, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import type { OutlineItem } from '@tangent/core/tree';
import type { TreeSummary } from '@tangent/shared';
import {
  ConversationSidebar,
  DEMO_MODE,
  Icon,
  Logo,
  ModeSwitch,
  SidebarBadges,
  SidebarHost,
  SidebarState,
} from '@tangent/web-shared';
import { confirmDeleteBranch } from '../dialogs/branch-settings';
import { confirmDeleteTree } from '../dialogs/tree-settings';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ImportButton } from '../ui/import-button';
import { ModeBadge } from '../ui/mode-badge';

/** Power's sidebar: the shared conversation sidebar, with the brand on top and the account below. */
@Component({
  selector: 'app-sidebar',
  imports: [
    ConversationSidebar,
    SidebarBadges,
    RouterLink,
    RouterLinkActive,
    Icon,
    ImportButton,
    Logo,
    ModeSwitch,
    ModeBadge,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: SidebarHost, useExisting: forwardRef(() => Sidebar) }],
  template: `
    <app-conversation-sidebar>
      <a routerLink="/" class="brand" (click)="close()"> <app-logo [size]="20" /> Tangent </a>
      <app-mode-switch current="power" />
      @if (store.account.me()?.devMode) {
        <span class="badge badge-warn" title="DEV_ALLOW_NO_AUTH is on">dev: auth disabled</span>
      }

      <ng-template sidebarBadges let-item>
        @let b = item.branch;
        @if (b.isPrivate) {
          <span class="lock" title="Private: excluded from shares and exports" aria-label="private">
            <app-icon name="lock" [size]="12" />
          </span>
        }
        @if (item.depth > 0) {
          <app-mode-badge [mode]="b.contextMode" />
        }
        @if (store.linkCounts().get(b.id) ?? 0; as links) {
          <span
            class="outline-links"
            [attr.aria-label]="links + (links === 1 ? ' link' : ' links')"
            [title]="(links === 1 ? '1 link' : links + ' links') + ' to other messages'"
          >
            <app-icon name="link" [size]="12" />{{ links }}
          </span>
        }
      </ng-template>

      <div class="sidebar-foot" sidebarFoot>
        <!-- The demo has no shares, keys, billing or account: nothing is published or signed in. -->
        @if (!demo) {
          @if (store.account.me()?.sharing) {
            <a
              routerLink="/shares"
              routerLinkActive="is-current"
              class="btn btn-ghost"
              (click)="close()"
            >
              <app-icon name="share" /> Shares
            </a>
          }
          <button
            type="button"
            class="btn btn-ghost"
            [attr.title]="keyTitle()"
            (click)="ui.dialogs.open({ kind: 'keys', provider: null }); close()"
          >
            <app-icon name="key" />
            {{ store.account.me()?.builtInCredit ? 'Keys & credit' : 'Keys' }}
            @if (store.account.keyStatus()?.hasKey) {
              <span class="dot-key" aria-label="Your key is stored"></span>
            }
          </button>
          <a
            routerLink="/billing"
            routerLinkActive="is-current"
            class="btn btn-ghost"
            (click)="close()"
          >
            Billing
          </a>
          <!-- The operator's accounts only (ADMIN_USER_IDS); a separate app, so a full page load. -->
          @if (store.account.me()?.isAdmin) {
            <a href="/admin/" class="btn btn-ghost"><app-icon name="lock" /> Admin</a>
          }
        }
        <app-import-button />
        <button
          type="button"
          class="btn btn-ghost"
          (click)="ui.dialogs.open({ kind: 'settings' }); close()"
        >
          <app-icon name="gear" /> Settings
        </button>
        @if (demo) {
          <a class="btn btn-ghost" [href]="exitUrl"><app-icon name="user" /> Leave the demo</a>
        } @else {
          <button
            type="button"
            class="btn btn-ghost"
            [attr.title]="store.account.me()?.email ?? 'Account'"
            (click)="ui.dialogs.open({ kind: 'account' }); close()"
          >
            <app-icon name="user" /> Account
          </button>
        }
      </div>
    </app-conversation-sidebar>
  `,
  host: { style: 'display: contents' },
})
export class Sidebar extends SidebarHost {
  readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);
  private readonly sidebar = inject(SidebarState);
  protected readonly demo = inject(DEMO_MODE);
  /** The public landing page. */
  protected readonly exitUrl = '/welcome';
  protected readonly keyTitle = computed(() => {
    const ids = this.store.account.keyStatus()?.providers ?? [];
    if (ids.length === 0) return 'API keys: none of your own stored';
    const labels = ids.map((id) => this.store.account.providerMap().get(id)?.label ?? id);
    return `API keys: yours for ${labels.join(', ')}`;
  });

  readonly words = {
    newTree: 'New conversation',
    trees: 'Conversations',
    noTrees: 'No conversations yet.',
    tree: 'conversation',
    branch: 'branch',
    branches: 'Branches',
  };
  readonly canRename = true;

  treeTitle(title: string): string {
    return title;
  }

  branchTitle(item: OutlineItem): string {
    return item.branch.title;
  }

  treeCount(t: TreeSummary): { text: string; title: string } {
    return {
      text: `${t.branchCount}·${t.messageCount}`,
      title: `${t.branchCount} branches, ${t.messageCount} messages`,
    };
  }

  /** Delete from the list, without opening the conversation (the button sits beside its link). */
  deleteTree(treeId: string, title: string): void {
    if (!confirmDeleteTree(title)) return;
    void this.store.deleteTree(treeId);
  }

  deleteBranch(branchId: string): void {
    void confirmDeleteBranch(this.store, branchId);
  }

  openBranch(item: OutlineItem): void {
    this.store.go(item.branch.id, null);
  }

  protected close(): void {
    this.sidebar.drawerOpen.set(false);
  }
}
