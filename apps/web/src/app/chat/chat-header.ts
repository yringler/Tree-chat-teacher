import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { Branch } from '@tangent/shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { DEMO_MODE, Icon } from '@tangent/web-shared';
import { ModeBadge } from '../ui/mode-badge';
import { ExportMenu } from './export-menu';

interface Crumb {
  branch: Branch;
  /** Message in this crumb's branch where the next branch in the chain forks off. */
  focusNodeId: string | null;
  current: boolean;
}

@Component({
  selector: 'app-chat-header',
  imports: [Icon, ModeBadge, ExportMenu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="chat-head">
      <div class="chat-head-row">
        <button
          type="button"
          class="icon-btn only-narrow"
          aria-label="Open menu"
          aria-controls="sidebar"
          [attr.aria-expanded]="ui.drawerOpen()"
          (click)="ui.drawerOpen.set(true)"
        >
          <app-icon name="menu" />
        </button>
        <h1 class="tree-name" [attr.title]="store.detail()?.tree?.title">
          {{ store.detail()?.tree?.title }}
        </h1>
        <div class="toolbar" role="toolbar" aria-label="Conversation actions">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            (click)="ui.branchSettingsOpen.set(true)"
            title="Branch settings"
          >
            <app-icon name="settings" /> <span class="hide-narrow">Branch</span>
          </button>
          <!-- Shares and exports are made by the server; the demo has none. Public links
               only while this user may publish them (MeResponse.sharing); export always. -->
          @if (!demo) {
            @if (store.me()?.sharing) {
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                (click)="ui.shareDialogOpen.set(true)"
              >
                <app-icon name="share" /> <span class="hide-narrow">Share…</span>
              </button>
            }
            <app-export-menu />
          }
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            (click)="ui.treeSettingsOpen.set(true)"
            title="Conversation settings"
          >
            <app-icon name="edit" /> <span class="hide-narrow">Tree</span>
          </button>
          <button
            type="button"
            class="icon-btn"
            [class.is-on]="ui.inspectorOpen()"
            [attr.aria-pressed]="ui.inspectorOpen()"
            aria-label="Context inspector (i)"
            title="Context inspector (i)"
            (click)="ui.toggleInspector()"
          >
            <app-icon name="panel" />
          </button>
          <button
            type="button"
            class="icon-btn"
            aria-label="Keyboard shortcuts (?)"
            title="Keyboard shortcuts (?)"
            (click)="ui.shortcutsOpen.set(true)"
          >
            <app-icon name="help" />
          </button>
        </div>
      </div>
      <div class="chat-head-row crumbs-row">
        @if (linkReturn(); as back) {
          <!-- After opening a link: back to the message it was opened from. -->
          <button
            type="button"
            class="link-return"
            [title]="'Back to the linked message in “' + back.label + '”'"
            (click)="goBack()"
          >
            <app-icon name="back" [size]="13" /> Back to ‘{{ clip(back.label) }}’
          </button>
        }
        <nav aria-label="Branch path" class="crumbs">
          <ol>
            @for (c of crumbs(); track c.branch.id; let last = $last) {
              <li>
                @if (c.current) {
                  <span class="crumb crumb-current" aria-current="page">{{ c.branch.title }}</span>
                } @else {
                  <button
                    type="button"
                    class="crumb"
                    (click)="store.go(c.branch.id, c.focusNodeId)"
                  >
                    {{ c.branch.title }}
                  </button>
                }
                @if (!last) {
                  <span class="crumb-sep" aria-hidden="true">›</span>
                }
              </li>
            }
          </ol>
        </nav>
        @if (store.selectedBranch(); as b) {
          @if (b.parentBranchId) {
            <app-mode-badge [mode]="b.contextMode" [long]="true" />
          }
          @if (b.isPrivate) {
            <span class="badge" title="Excluded from shares and exports"
              ><app-icon name="lock" [size]="12" /> private</span
            >
          }
          @if (b.parentBranchId && b.branchPointNodeId) {
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              (click)="toParent()"
              title="Parent message (Alt+↑ or [)"
            >
              <app-icon name="back" /> Parent message
            </button>
          }
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            [disabled]="!firstNodeId()"
            [title]="
              firstNodeId()
                ? 'Link this branch (its first message) to another message'
                : 'The branch has no messages to link yet'
            "
            (click)="linkBranch()"
          >
            <app-icon name="link" /> Link this branch…
          </button>
        }
      </div>
    </header>
  `,
})
export class ChatHeader {
  protected readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);
  protected readonly demo = inject(DEMO_MODE);

  protected readonly crumbs = computed<Crumb[]>(() => {
    const chain = this.store.chain();
    return chain.map((branch, i) => ({
      branch,
      focusNodeId: chain[i + 1]?.branchPointNodeId ?? null,
      current: i === chain.length - 1,
    }));
  });

  /** The return pill, while the view is still where the link went. */
  protected readonly linkReturn = computed(() => {
    const back = this.ui.linkReturn();
    if (!back || back.toBranchId !== this.store.selectedBranchId()) return null;
    return this.store.focusedNodeId() === back.focusNodeId ? null : back;
  });

  /** "Link this branch…" links its first message. */
  protected readonly firstNodeId = computed(() => {
    const b = this.store.selectedBranch();
    return b ? (this.store.firstNodeOf(b.id)?.id ?? null) : null;
  });

  protected clip(title: string): string {
    return title.length > 32 ? `${title.slice(0, 31).trimEnd()}…` : title;
  }

  protected goBack(): void {
    const back = this.ui.linkReturn();
    if (!back) return;
    this.ui.linkReturn.set(null);
    this.store.go(back.branchId, back.focusNodeId);
  }

  protected linkBranch(): void {
    const id = this.firstNodeId();
    if (!id) return;
    this.ui.linkPick.set(null);
    this.ui.linkDialog.set({ fromNodeId: id });
  }

  protected toParent(): void {
    const b = this.store.selectedBranch();
    if (b?.parentBranchId) this.store.go(b.parentBranchId, b.branchPointNodeId);
  }
}
