import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { parseReview } from '@tangent/shared';
import { Icon } from '@tangent/web-shared';
import { ReviewStore } from '../state/review-store';
import { UiStore } from '../state/ui-store';
import { ReviewVerdict } from '../ui/review-verdict';

/** Under a reviewed reply: the review's state and verdict; opens the review. */
@Component({
  selector: 'app-review-chip',
  imports: [Icon, ReviewVerdict],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    @if (review(); as r) {
      <button type="button" class="review-chip" (click)="open($event)">
        <app-icon name="review" [size]="13" />
        @switch (r.phase) {
          @case ('running') {
            <span>Reviewing…</span>
          }
          @case ('error') {
            <span>Review failed</span>
          }
          @default {
            <span>Reviewed</span>
            <app-review-verdict
              [accuracy]="verdict()?.accuracy ?? null"
              [recommendation]="verdict()?.recommendation ?? null"
            />
          }
        }
      </button>
    }
  `,
})
export class ReviewChip {
  private readonly reviews = inject(ReviewStore);
  private readonly ui = inject(UiStore);
  readonly nodeId = input.required<string>();

  protected readonly review = computed(() => this.reviews.reviews().get(this.nodeId()) ?? null);
  protected readonly verdict = computed(() => {
    const r = this.review();
    return r?.phase === 'done' ? parseReview(r.text) : null;
  });

  protected open(e: Event): void {
    e.stopPropagation();
    this.ui.dialogs.open({ kind: 'review', nodeId: this.nodeId() });
  }
}
