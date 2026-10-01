import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { Branch } from '@tangent/shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { Icon } from '@tangent/web-shared';
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
          <button type="button" class="btn btn-ghost btn-sm" (click)="ui.shareDialogOpen.set(true)">
            <app-icon name="share" /> <span class="hide-narrow">Share…</span>
          </button>
          <app-export-menu />
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
        }
      </div>
    </header>
  `,
})
export class ChatHeader {
  protected readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);

  protected readonly crumbs = computed<Crumb[]>(() => {
    const chain = this.store.chain();
    return chain.map((branch, i) => ({
      branch,
      focusNodeId: chain[i + 1]?.branchPointNodeId ?? null,
      current: i === chain.length - 1,
    }));
  });

  protected toParent(): void {
    const b = this.store.selectedBranch();
    if (b?.parentBranchId) this.store.go(b.parentBranchId, b.branchPointNodeId);
  }
}
