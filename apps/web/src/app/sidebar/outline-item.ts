import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { OutlineItem as OutlineNode } from '@tangent/core';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { Icon } from '../ui/icon';
import { ModeBadge } from '../ui/mode-badge';

/** One branch in the outline (recursive). */
@Component({
  selector: 'app-outline-item',
  imports: [Icon, ModeBadge, OutlineItem],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let b = item().branch;
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
            [attr.aria-label]="(collapsed() ? 'Expand ' : 'Collapse ') + b.title"
            [attr.aria-expanded]="!collapsed()"
            (click)="ui.toggleCollapsed(b.id)"
          >
            <app-icon [name]="collapsed() ? 'chevronRight' : 'chevronDown'" [size]="14" />
          </button>
        } @else {
          <span class="twisty-spacer"></span>
        }
        <button
          type="button"
          class="outline-link"
          [attr.aria-current]="selected() ? 'page' : null"
          [attr.title]="b.title"
          (click)="open()"
        >
          <span class="outline-title">{{ b.title }}</span>
          @if (streaming()) {
            <span class="dot-live" aria-label="generating"></span>
          }
          @if (b.isPrivate) {
            <span
              class="lock"
              title="Private: excluded from shares and exports"
              aria-label="private"
            >
              <app-icon name="lock" [size]="12" />
            </span>
          }
          @if (item().depth > 0) {
            <app-mode-badge [mode]="b.contextMode" />
          }
          <span class="count" [attr.aria-label]="item().messageCount + ' messages'">{{
            item().messageCount
          }}</span>
        </button>
      </div>
      @if (hasChildren() && !collapsed()) {
        <ul role="group">
          @for (child of item().children; track child.branch.id) {
            <app-outline-item [item]="child" />
          }
        </ul>
      }
    </li>
  `,
  host: { style: 'display: contents' },
})
export class OutlineItem {
  protected readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);
  readonly item = input.required<OutlineNode>();

  protected readonly hasChildren = computed(() => this.item().children.length > 0);
  protected readonly collapsed = computed(() => this.ui.collapsed().has(this.item().branch.id));
  protected readonly selected = computed(
    () => this.store.selectedBranchId() === this.item().branch.id,
  );
  protected readonly inChain = computed(() =>
    this.store.chain().some((b) => b.id === this.item().branch.id),
  );
  protected readonly streaming = computed(() => {
    const id = this.item().branch.id;
    for (const s of this.store.live().values()) if (s.branchId === id) return true;
    return false;
  });

  protected open(): void {
    const b = this.item().branch;
    this.store.go(b.id, null);
  }
}
