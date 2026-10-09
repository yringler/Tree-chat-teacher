import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import type { OutlineItem } from '@tangent/core/tree';
import { Modal } from '@tangent/web-shared';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { branchTitle } from './titles';

/** Indents stop deepening here, so a deep side question still has room for its title on a phone. */
const MAX_DEPTH = 6;

/**
 * "Lesson map": the lesson and every side question in it, nested under the
 * one it came from, the way to the open one marked. A side question opens
 * at its first message, as from its chip; the lesson where it continues.
 */
@Component({
  selector: 'app-lesson-map',
  imports: [Modal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal class="map-sheet" heading="Lesson map" (closed)="close()">
      <ol class="lesson-map">
        @for (item of store.flatOutline(); track item.branch.id; let first = $first) {
          <li [style.--depth]="depth(item)">
            <button
              type="button"
              class="lesson-map-row"
              [class.in-chain]="store.chainIds().has(item.branch.id)"
              [attr.aria-current]="item.branch.id === store.selectedBranchId() ? 'page' : null"
              (click)="open(item, first)"
            >
              <span class="lesson-map-title">{{
                first ? 'Lesson' : branchTitle(item.branch)
              }}</span>
              <span class="muted small">
                {{ item.messageCount }} {{ item.messageCount === 1 ? 'message' : 'messages' }}
              </span>
            </button>
          </li>
        }
      </ol>
      <p class="muted small lesson-map-keys">Press ? for keyboard shortcuts.</p>
    </app-modal>
  `,
})
export class LessonMap {
  protected readonly store = inject(LessonStore);
  private readonly ui = inject(UiStore);
  protected readonly branchTitle = branchTitle;

  constructor() {
    // The lesson went away under the map (another one opened, or none).
    effect(() => {
      if (!this.store.index()) this.close();
    });
  }

  protected depth(item: OutlineItem): number {
    return Math.min(item.depth, MAX_DEPTH);
  }

  protected open(item: OutlineItem, trunk: boolean): void {
    this.close();
    if (trunk) this.store.go(item.branch.id);
    else this.store.openAtStart(item.branch.id);
  }

  protected close(): void {
    this.ui.dialogs.close('map');
  }
}
