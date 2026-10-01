import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ReviewAccuracy, ReviewRecommendation } from '@tangent/shared';

const ACCURACY: Record<ReviewAccuracy, { label: string; cls: string; title: string }> = {
  ok: { label: 'no errors', cls: 'badge-ok', title: 'The reviewer found nothing wrong' },
  minor: { label: 'minor issues', cls: 'badge-warn', title: 'The reviewer found small mistakes' },
  major: {
    label: 'major issues',
    cls: 'badge-danger',
    title: 'The reviewer found serious mistakes',
  },
};

/** Badges for a review's verdict; renders nothing for unknown values. */
@Component({
  selector: 'app-review-verdict',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (accuracy(); as a) {
      <span class="badge {{ map[a].cls }}" [attr.title]="map[a].title">{{ map[a].label }}</span>
    }
    @if (recommendation() === 'upgrade') {
      <span class="badge badge-warn" title="The reviewer suggests continuing on a stronger model"
        >upgrade model</span
      >
    } @else if (recommendation() === 'stay') {
      <span class="badge" title="The reviewer thinks the current model is coping">model ok</span>
    }
  `,
  host: { class: 'review-verdict' },
})
export class ReviewVerdict {
  readonly accuracy = input<ReviewAccuracy | null>(null);
  readonly recommendation = input<ReviewRecommendation | null>(null);
  protected readonly map = ACCURACY;
}
