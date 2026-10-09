import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { POOL_EMPTY_TEXT, type PoolStatusResponse } from '@tangent/shared';
import { poolDollarsLabel, sessionsLabel } from './pool-format';

/**
 * The open pool meter: about how many learning sessions the
 * pool still covers, and the dollars. Styles: `.pool-*` in base.css.
 */
@Component({
  selector: 'app-pool-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pool-meter" role="group" aria-label="Open pool">
      <p class="pool-meter-sessions">{{ headline() }}</p>
      <p class="pool-meter-dollars">{{ dollars() }}</p>
    </div>
  `,
})
export class PoolMeter {
  readonly status = input.required<PoolStatusResponse>();

  protected readonly headline = computed(() =>
    this.status().sessionsRemaining > 0 ? `${sessionsLabel(this.status())} left` : POOL_EMPTY_TEXT,
  );
  protected readonly dollars = computed(() => poolDollarsLabel(this.status()));
}
