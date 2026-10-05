import { ChangeDetectionStrategy, Component, inject, signal, type OnInit } from '@angular/core';
import { poolFundingText, type PoolStatusResponse } from '@tangent/shared';
import { ApiClient } from '../core/api-client';
import { Icon } from '../ui/icon';
import { ImpactFeed } from './impact-feed';
import { PoolMeter } from './pool-meter';

/**
 * "The community pool" on the billing page of both apps: the meter, last
 * week's impact feed once a snapshot exists, where the pool's credit comes
 * from (`poolFundingText`: Tangent's revenue share; nobody buys pool credit)
 * and a link to `/pool`. Nothing renders while the pool is off or its status
 * can't be read.
 */
@Component({
  selector: 'app-pool-section',
  imports: [Icon, ImpactFeed, PoolMeter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (status(); as s) {
      @if (s.enabled) {
        <section class="card billing-section pool-section" aria-labelledby="pool-section-h">
          <h2 id="pool-section-h" class="billing-h">The community pool</h2>
          <app-pool-meter [status]="s" />
          <app-impact-feed />
          <p class="muted small">
            {{ funding(s) }} Any signed-in learner can use it on {{ s.model.label }}, within daily
            limits.
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

  protected funding(s: PoolStatusResponse): string {
    return poolFundingText(s.revenueShareBps);
  }
}
