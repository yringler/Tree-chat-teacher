import { ChangeDetectionStrategy, Component, forwardRef, inject } from '@angular/core';
import type { OutlineItem } from '@tangent/core/tree';
import type { TreeSummary } from '@tangent/shared';
import { ConversationSidebar, PowerSidebarFoot, SidebarHost } from '@tangent/web-shared';
import { DEMO_EXIT_URL } from '../brand';
import { confirmDeleteLane, confirmDeleteTree } from '../canvas/delete-lane';
import { laneTitle, treeTitle } from '../canvas/titles';
import { LayoutStore } from '../layout/layout-store';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';

/**
 * Canvas's sidebar: the shared conversation sidebar with the open one's
 * lanes as an outline, and power's account entries below. Picking a lane in
 * the outline moves the canvas to it: it is the user's explicit ask, so the
 * view moves even when that lane is already the selected one.
 */
@Component({
  selector: 'app-canvas-sidebar',
  imports: [ConversationSidebar, PowerSidebarFoot],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: SidebarHost, useExisting: forwardRef(() => CanvasSidebar) }],
  template: `
    <app-conversation-sidebar>
      <div class="sidebar-foot" sidebarFoot>
        <!-- Shares and Billing are power's pages. -->
        <app-power-sidebar-foot
          [exitUrl]="exitUrl"
          (keys)="ui.dialogs.open({ kind: 'keys' })"
          (openAccount)="ui.dialogs.open({ kind: 'account' })"
        />
      </div>
    </app-conversation-sidebar>
  `,
  host: { style: 'display: contents' },
})
export class CanvasSidebar extends SidebarHost {
  readonly store = inject(CanvasStore);
  protected readonly ui = inject(UiStore);
  private readonly geo = inject(LayoutStore);
  protected readonly exitUrl = DEMO_EXIT_URL;

  readonly words = {
    newTree: 'New conversation',
    trees: 'Conversations',
    noTrees: 'No conversations yet.',
    tree: 'conversation',
    branch: 'lane',
    branches: 'Lanes',
  };
  readonly canRename = true;

  treeTitle(title: string): string {
    return treeTitle(title);
  }

  branchTitle(item: OutlineItem): string {
    return laneTitle(item.branch);
  }

  treeCount(t: TreeSummary): { text: string; title: string } {
    const lanes = `${t.branchCount} ${t.branchCount === 1 ? 'lane' : 'lanes'}`;
    const messages = `${t.messageCount} ${t.messageCount === 1 ? 'message' : 'messages'}`;
    return { text: `${t.branchCount}·${t.messageCount}`, title: `${lanes}, ${messages}` };
  }

  deleteTree(treeId: string, title: string): void {
    if (!confirmDeleteTree(title)) return;
    void this.store.deleteTree(treeId);
  }

  deleteBranch(branchId: string): void {
    void confirmDeleteLane(this.store, branchId);
  }

  /**
   * Selects the lane; the canvas page follows a new selection to it. Picked
   * again while it is selected (the user has panned away since), the canvas
   * goes back to it here, since the selection doesn't change.
   */
  openBranch(item: OutlineItem): void {
    const id = item.branch.id;
    if (this.store.selectedBranchId() === id && this.store.focusedNodeId() === null) {
      this.geo.centerOn(id);
    } else {
      this.store.go(id);
    }
  }
}
