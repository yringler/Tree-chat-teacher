import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import type { Branch } from '@tangent/shared';
import { Icon } from '@tangent/web-shared';
import { confirmDeleteBranch } from '../dialogs/branch-settings';
import { TreeStore } from '../state/tree-store';
import { ModeBadge } from '../ui/mode-badge';

/** "N branches" under a message: the branches started from it, to open or delete. */
@Component({
  selector: 'app-fork-list',
  imports: [Icon, ModeBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    @if (branches().length > 0) {
      <div class="forks">
        <button
          type="button"
          class="fork-toggle"
          [attr.aria-expanded]="open()"
          (click)="$event.stopPropagation(); open.set(!open())"
        >
          <app-icon name="branch" [size]="13" />
          {{ branches().length }} {{ branches().length === 1 ? 'branch' : 'branches' }}
          <app-icon [name]="open() ? 'chevronDown' : 'chevronRight'" [size]="13" />
        </button>
        @if (open()) {
          <ul class="fork-list">
            @for (b of branches(); track b.id) {
              <li class="fork-row">
                <button
                  type="button"
                  class="fork-link"
                  [class.in-chain]="chainIds().has(b.id)"
                  (click)="jump($event, b)"
                >
                  <span class="outline-title">{{ b.title }}</span>
                  <app-mode-badge [mode]="b.contextMode" />
                  @if (b.isPrivate) {
                    <app-icon name="lock" [size]="12" />
                  }
                  <span class="count">{{ countOf(b.id) }}</span>
                </button>
                <!-- Delete without going through the outline (shown on hover or keyboard focus). -->
                <span class="row-actions">
                  <button
                    type="button"
                    class="icon-btn icon-btn-danger"
                    [attr.aria-label]="'Delete ' + b.title"
                    title="Delete branch"
                    (click)="remove($event, b)"
                  >
                    <app-icon name="trash" [size]="13" />
                  </button>
                </span>
              </li>
            }
          </ul>
        }
      </div>
    }
  `,
})
export class ForkList {
  private readonly store = inject(TreeStore);
  readonly branches = input.required<readonly Branch[]>();
  /** The selected branch's chain (its branches are marked). */
  readonly chainIds = input<ReadonlySet<string>>(new Set());
  protected readonly open = signal(false);

  protected countOf(branchId: string): number {
    return this.store.index()?.nodesByBranch.get(branchId)?.length ?? 0;
  }

  protected async remove(e: Event, b: Branch): Promise<void> {
    e.stopPropagation();
    await confirmDeleteBranch(this.store, b.id);
  }

  protected jump(e: Event, b: Branch): void {
    e.stopPropagation();
    this.store.openAtStart(b.id);
  }
}
