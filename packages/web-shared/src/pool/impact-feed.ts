import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  poolImpactDepthText,
  poolImpactHeadline,
  poolImpactTopicText,
  type PoolImpactResponse,
  type PoolImpactTopic,
} from '@tangent/shared';
import { ApiClient, ApiError } from '../core/api-client';
import { Icon } from '../ui/icon';

/**
 * The latest weekly impact snapshot; null when there is none yet (404). Any
 * other failure is thrown.
 */
export async function loadLatestImpact(
  api: Pick<ApiClient, 'poolImpact'>,
): Promise<PoolImpactResponse | null> {
  try {
    return await api.poolImpact();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * What the pool funded last week (spec §9 "UI"), next to the meter in the
 * fund section: the headline, the branch-depth line and the topics the
 * snapshot names (enough learners, not sensitive, approved), with a link to
 * past weeks on `/pool`. Aggregates only. Renders nothing until there is a
 * snapshot, or when it can't be loaded.
 */
@Component({
  selector: 'app-impact-feed',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (impact(); as i) {
      <div class="pool-impact" role="group" aria-label="What the pool funded">
        <p class="pool-impact-head">{{ headline(i) }}</p>
        <p class="muted small">{{ depth(i) }}</p>
        @if (i.named.length) {
          <ul class="pool-impact-topics" aria-label="Topics">
            @for (t of i.named; track t.id) {
              <li>{{ topic(t) }}</li>
            }
          </ul>
        }
        <p class="small">
          <a href="/pool#impact" target="_blank" rel="noopener">
            Past weeks <app-icon name="external" [size]="12" />
          </a>
        </p>
      </div>
    }
  `,
})
export class ImpactFeed {
  private readonly api = inject(ApiClient);
  protected readonly impact = signal<PoolImpactResponse | null>(null);

  constructor() {
    loadLatestImpact(this.api).then(
      (i) => this.impact.set(i),
      () => this.impact.set(null),
    );
  }

  protected headline(i: PoolImpactResponse): string {
    return poolImpactHeadline(i);
  }

  protected depth(i: PoolImpactResponse): string {
    return poolImpactDepthText(i);
  }

  protected topic(t: PoolImpactTopic): string {
    return poolImpactTopicText(t);
  }
}
