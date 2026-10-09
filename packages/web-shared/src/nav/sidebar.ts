import { ChangeDetectionStrategy, Component, computed, contentChild, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../ui/icon';
import { SidebarBadges, SidebarOutlineItem } from './outline-item';
import { SidebarHost, SidebarState } from './sidebar-host';

/**
 * The conversation sidebar: "New …", every conversation, and the open one's
 * branches as an outline under it. The app's sidebar component wraps it,
 * provides itself as `SidebarHost`, projects its head (brand, switch) and an
 * element marked `sidebarFoot`, and may add `<ng-template sidebarBadges>`, a template of extra
 * marks after each branch's title.
 */
@Component({
  selector: 'app-conversation-sidebar',
  imports: [RouterLink, Icon, SidebarOutlineItem],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sidebar-head">
      <ng-content />
      <button type="button" class="icon-btn only-narrow" aria-label="Close menu" (click)="close()">
        <app-icon name="x" />
      </button>
    </div>

    <a routerLink="/" class="btn btn-primary new-btn" (click)="close()">
      <app-icon name="plus" /> {{ host.words.newTree }}
    </a>

    <nav class="tree-list" [attr.aria-label]="host.words.trees">
      @if (store.treesLoaded() && store.trees().length === 0) {
        <p class="muted small pad">{{ host.words.noTrees }}</p>
      }
      <ul>
        @for (t of store.trees(); track t.id) {
          @let current = t.id === store.selectedTreeId();
          @let title = host.treeTitle(current ? (store.detail()?.tree?.title ?? t.title) : t.title);
          @let count = host.treeCount(t);
          <li>
            <div class="tree-row" [class.is-current]="current">
              <a
                class="tree-link"
                [routerLink]="['/t', t.id]"
                [class.is-current]="current"
                [attr.aria-current]="current ? 'true' : null"
                (click)="close()"
              >
                <span class="tree-title">{{ title }}</span>
                <span class="count" [attr.title]="count.title">{{ count.text }}</span>
              </a>
              <span class="row-actions">
                <button
                  type="button"
                  class="icon-btn icon-btn-danger"
                  [attr.aria-label]="'Delete ' + title"
                  [title]="'Delete ' + host.words.tree"
                  (click)="host.deleteTree(t.id, title)"
                >
                  <app-icon name="trash" [size]="13" />
                </button>
              </span>
            </div>
            @if (current) {
              @if (store.outline(); as root) {
                <ul class="outline" role="tree" [attr.aria-label]="host.words.branches">
                  <app-sidebar-outline-item [item]="root" [badges]="badges()" />
                </ul>
              } @else if (store.detailLoading()) {
                <p class="muted small pad">Loading…</p>
              }
            }
          </li>
        }
      </ul>
    </nav>

    <ng-content select="[sidebarFoot]" />
  `,
  host: { class: 'sidebar-inner' },
})
export class ConversationSidebar {
  protected readonly host = inject(SidebarHost);
  protected readonly store = this.host.store;
  private readonly sidebar = inject(SidebarState);
  private readonly badgesDir = contentChild(SidebarBadges);
  protected readonly badges = computed(() => this.badgesDir()?.template);

  protected close(): void {
    this.sidebar.drawerOpen.set(false);
  }
}
