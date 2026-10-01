import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type { OutlineItem as OutlineNode } from '@tangent/core';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { Icon } from '../ui/icon';
import { confirmDeleteBranch } from '../dialogs/branch-settings';
import { ModeBadge } from '../ui/mode-badge';

/** One branch in the outline (recursive), with inline rename and delete. */
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
        @if (editing()) {
          <input
            #titleInput
            type="text"
            class="outline-rename"
            maxlength="200"
            aria-label="Branch title"
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
            [attr.title]="b.title + ' (double-click to rename)'"
            (click)="open()"
            (dblclick)="startRename()"
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
          <span class="outline-actions">
            <button
              type="button"
              class="icon-btn"
              [attr.aria-label]="'Rename ' + b.title"
              title="Rename"
              (click)="startRename()"
            >
              <app-icon name="edit" [size]="13" />
            </button>
            @if (item().depth > 0) {
              <button
                type="button"
                class="icon-btn icon-btn-danger"
                [attr.aria-label]="'Delete ' + b.title"
                title="Delete branch"
                (click)="remove()"
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

  protected readonly editing = signal(false);
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');
  /** Enter commits and then blur fires again on the removed input; only save once. */
  private saving = false;

  protected open(): void {
    const b = this.item().branch;
    this.store.go(b.id, null);
  }

  protected startRename(): void {
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

  protected async remove(): Promise<void> {
    await confirmDeleteBranch(this.store, this.item().branch.id);
  }
}
