import { ChangeDetectionStrategy, Component, inject, signal, type OnInit } from '@angular/core';
import { POOL_FUNDING_TEXT, poolModelText, type PoolStatusResponse } from '@tangent/shared';
import { ApiClient } from '../core/api-client';
import { Icon } from '../ui/icon';
import { PoolMeter } from './pool-meter';

/**
 * "The open pool" on the billing page of both apps: the meter, where the
 * pool's credit comes from (`POOL_FUNDING_TEXT`; nobody buys pool credit) and
 * a link to `/pool`. Nothing renders while the pool is off or its status
 * can't be read.
 */
@Component({
  selector: 'app-pool-section',
  imports: [Icon, PoolMeter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (status(); as s) {
      @if (s.enabled) {
        <section class="card billing-section pool-section" aria-labelledby="pool-section-h">
          <h2 id="pool-section-h" class="billing-h">The open pool</h2>
          <app-pool-meter [status]="s" />
          <p class="muted small">
            {{ funding }} Any signed-in learner can use it on {{ model(s) }}, within daily limits.
          </p>
          <p class="small">
            <a href="/pool" target="_blank" rel="noopener">
              How the pool works <app-icon name="external" [size]="12" />
            </a>
          </p>
        </section>
      }
    }
  `,
})
export class PoolSection implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly status = signal<PoolStatusResponse | null>(null);

  ngOnInit(): void {
    this.api.poolStatus().then(
      (s) => this.status.set(s),
      () => this.status.set(null),
    );
  }

  /** The pool's model, as the copy names it (`poolModelText`). */
  protected model(s: PoolStatusResponse): string {
    return poolModelText(s.model);
  }

  protected readonly funding = POOL_FUNDING_TEXT;
}
