import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  Directive,
  type ElementRef,
  inject,
  input,
  signal,
  TemplateRef,
  viewChild,
} from '@angular/core';
import type { OutlineItem } from '@tangent/core/tree';
import { Icon } from '../ui/icon';
import { SidebarHost, SidebarState } from './sidebar-host';

/** What an app's badges template gets: the branch's outline item. */
export interface BadgeContext {
  $implicit: OutlineItem;
}

/**
 * Marks the app's `<ng-template sidebarBadges let-item>` inside
 * `app-conversation-sidebar`: extra marks after each branch's title, `item`
 * typed as its outline item.
 */
@Directive({ selector: 'ng-template[sidebarBadges]' })
export class SidebarBadges {
  readonly template = inject<TemplateRef<BadgeContext>>(TemplateRef);

  static ngTemplateContextGuard(_dir: SidebarBadges, _ctx: unknown): _ctx is BadgeContext {
    return true;
  }
}

/** One branch in the sidebar's outline (recursive), with rename (where the app allows) and delete. */
@Component({
  selector: 'app-sidebar-outline-item',
  imports: [Icon, NgTemplateOutlet, SidebarOutlineItem],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let b = item().branch;
    @let title = host.branchTitle(item());
    <li
      role="treeitem"
      [attr.aria-level]="item().depth + 1"
      [attr.aria-selected]="selected()"
      [attr.aria-expanded]="hasChildren() ? !collapsed() : null"
    >
      <div class="outline-row" [class.is-selected]="selected()" [class.in-chain]="inChain()">
        @if (hasChildren()) {
          <button
            type="button"
            class="icon-btn twisty"
            [attr.aria-label]="(collapsed() ? 'Expand ' : 'Collapse ') + title"
            [attr.aria-expanded]="!collapsed()"
            (click)="sidebar.toggleCollapsed(b.id)"
          >
            <app-icon [name]="collapsed() ? 'chevronRight' : 'chevronDown'" [size]="14" />
          </button>
        } @else {
          <span class="twisty-spacer"></span>
        }
        @if (editing()) {
          <input
            #titleInput
            type="text"
            class="outline-rename"
            maxlength="200"
            aria-label="Title"
            [value]="b.title"
            (keydown.enter)="$event.preventDefault(); commitRename(titleInput.value)"
            (keydown.escape)="$event.preventDefault(); editing.set(false)"
            (blur)="commitRename(titleInput.value)"
          />
        } @else {
          <button
            type="button"
            class="outline-link"
            [attr.aria-current]="selected() ? 'page' : null"
            [attr.title]="host.canRename ? title + ' (double-click to rename)' : title"
            (click)="open()"
            (dblclick)="startRename()"
          >
            <span class="outline-title">{{ title }}</span>
            @if (streaming()) {
              <span class="dot-live" aria-label="generating"></span>
            }
            @if (badges(); as tpl) {
              <ng-container *ngTemplateOutlet="tpl; context: { $implicit: item() }" />
            }
            <span class="count" [attr.aria-label]="item().messageCount + ' messages'">{{
              item().messageCount
            }}</span>
          </button>
          <span class="outline-actions">
            @if (host.canRename) {
              <button
                type="button"
                class="icon-btn"
                [attr.aria-label]="'Rename ' + title"
                title="Rename"
                (click)="startRename()"
              >
                <app-icon name="edit" [size]="13" />
              </button>
            }
            @if (item().depth > 0) {
              <button
                type="button"
                class="icon-btn icon-btn-danger"
                [attr.aria-label]="'Delete ' + title"
                [title]="'Delete ' + host.words.branch"
                (click)="host.deleteBranch(b.id)"
              >
                <app-icon name="trash" [size]="13" />
              </button>
            }
          </span>
        }
      </div>
      @if (hasChildren() && !collapsed()) {
        <ul role="group">
          @for (child of item().children; track child.branch.id) {
            <app-sidebar-outline-item [item]="child" [badges]="badges()" />
          }
        </ul>
      }
    </li>
  `,
  host: { style: 'display: contents' },
})
export class SidebarOutlineItem {
  protected readonly host = inject(SidebarHost);
  protected readonly sidebar = inject(SidebarState);
  readonly item = input.required<OutlineItem>();
  /** The app's extra marks after the title (e.g. power's context mode). */
  readonly badges = input<TemplateRef<BadgeContext> | undefined>();

  private readonly store = this.host.store;
  protected readonly hasChildren = computed(() => this.item().children.length > 0);
  protected readonly collapsed = computed(() =>
    this.sidebar.collapsed().has(this.item().branch.id),
  );
  protected readonly selected = computed(
    () => this.store.selectedBranchId() === this.item().branch.id,
  );
  protected readonly inChain = computed(() => this.store.chainIds().has(this.item().branch.id));
  protected readonly streaming = computed(() => {
    const id = this.item().branch.id;
    for (const s of this.store.live().values()) if (s.branchId === id) return true;
    return false;
  });

  protected readonly editing = signal(false);
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');
  /** Enter commits and then blur fires again on the removed input; only save once. */
  private saving = false;

  protected open(): void {
    this.sidebar.drawerOpen.set(false);
    this.host.openBranch(this.item());
  }

  protected startRename(): void {
    if (!this.host.canRename) return;
    this.editing.set(true);
    queueMicrotask(() => {
      const el = this.titleInput()?.nativeElement;
      el?.focus();
      el?.select();
    });
  }

  protected async commitRename(value: string): Promise<void> {
    if (!this.editing() || this.saving) return;
    const b = this.item().branch;
    const title = value.trim();
    if (!title || title === b.title) {
      this.editing.set(false);
      return;
    }
    this.saving = true;
    const ok = await this.store.updateBranch(b.id, { title });
    this.saving = false;
    // On failure the error toast shows and the input stays open to retry or Esc.
    if (ok) this.editing.set(false);
  }
}
