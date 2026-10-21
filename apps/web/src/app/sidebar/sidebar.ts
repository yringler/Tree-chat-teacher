import { ChangeDetectionStrategy, Component, forwardRef, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { OutlineItem } from '@tangent/core/tree';
import { HELP_TITLE, type TreeSummary } from '@tangent/shared';
import {
  ConversationSidebar,
  Icon,
  Logo,
  ModeSwitch,
  PowerSidebarFoot,
  SidebarBadges,
  SidebarHost,
  SidebarState,
} from '@tangent/web-shared';
import { confirmDeleteBranch } from '../dialogs/branch-settings';
import { confirmDeleteTree } from '../dialogs/tree-settings';
import { threadTitle } from '../state/thread-title';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ModeBadge } from '../ui/mode-badge';

/** Power's sidebar: the shared conversation sidebar, with the brand on top and the account below. */
@Component({
  selector: 'app-sidebar',
  imports: [
    ConversationSidebar,
    SidebarBadges,
    RouterLink,
    Icon,
    Logo,
    ModeSwitch,
    ModeBadge,
    PowerSidebarFoot,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: SidebarHost, useExisting: forwardRef(() => Sidebar) }],
  template: `
    <app-conversation-sidebar>
      <a routerLink="/" class="brand" (click)="close()"> <app-logo [size]="20" /> Tangent </a>
      <app-mode-switch
        current="power"
        [treeId]="store.selectedTreeId()"
        [branchId]="store.selectedBranchId()"
      />
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
        <app-power-sidebar-foot
          [ownPages]="true"
          [exitUrl]="exitUrl"
          (keys)="ui.dialogs.open({ kind: 'keys', provider: null })"
          (openAccount)="ui.dialogs.open({ kind: 'account' })"
        >
          <button
            type="button"
            class="btn btn-ghost"
            (click)="ui.dialogs.open({ kind: 'settings' }); close()"
          >
            <app-icon name="gear" /> Settings
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            (click)="ui.dialogs.open({ kind: 'help' }); close()"
          >
            <app-icon name="help" /> {{ helpTitle }}
          </button>
        </app-power-sidebar-foot>
      </div>
    </app-conversation-sidebar>
  `,
  host: { style: 'display: contents' },
})
export class Sidebar extends SidebarHost {
  readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);
  private readonly sidebar = inject(SidebarState);
  /** The public landing page. */
  protected readonly exitUrl = '/welcome';
  protected readonly helpTitle = HELP_TITLE;

  readonly words = {
    newTree: 'New conversation',
    trees: 'Conversations',
    noTrees: 'No conversations yet.',
    tree: 'conversation',
    branch: 'tangent',
    branches: 'Tangents',
  };
  readonly canRename = true;

  treeTitle(title: string): string {
    return title;
  }

  branchTitle(item: OutlineItem): string {
    return threadTitle(item.branch);
  }

  treeCount(t: TreeSummary): { text: string; title: string } {
    return {
      text: `${t.branchCount - 1}·${t.messageCount}`,
      title: `${t.branchCount - 1} ${t.branchCount === 2 ? 'tangent' : 'tangents'}, ${t.messageCount} messages`,
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
