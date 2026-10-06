import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { POOL_EMPTY_TEXT, type PoolStatusResponse } from '@tangent/shared';
import { poolDollarsLabel, poolWeekLabel, sessionsLabel } from './pool-format';

/**
 * The open pool meter (spec §8): about how many learning sessions the
 * pool still covers, the dollars, and this week's learners and exchanges
 * (aggregate counts only). `compact` drops the week line. Styles: `.pool-*`
 * in base.css.
 */
@Component({
  selector: 'app-pool-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pool-meter" role="group" aria-label="Open pool">
      <p class="pool-meter-sessions">{{ headline() }}</p>
      <p class="pool-meter-dollars">{{ dollars() }}</p>
      @if (!compact()) {
        <p class="pool-meter-week">{{ week() }}</p>
      }
    </div>
  `,
})
export class PoolMeter {
  readonly status = input.required<PoolStatusResponse>();
  readonly compact = input(false);

  protected readonly headline = computed(() =>
    this.status().sessionsRemaining > 0 ? `${sessionsLabel(this.status())} left` : POOL_EMPTY_TEXT,
  );
  protected readonly dollars = computed(() => poolDollarsLabel(this.status()));
  protected readonly week = computed(() => poolWeekLabel(this.status()));
}
