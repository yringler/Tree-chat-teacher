import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import type { PoolStatusResponse } from '@tangent/shared';
import { formatCents } from '../billing/format';
import { ApiClient } from '../core/api-client';
import { DEMO_MODE } from '../core/demo';
import { Icon } from '../ui/icon';
import { ImpactFeed } from './impact-feed';
import { PoolFundController } from './pool-fund-controller';
import { poolFundingNote } from './pool-format';
import { PoolMeter } from './pool-meter';

/**
 * "Fund the community pool" on the billing page of both apps (`#fund-pool`):
 * the meter, preset amounts at or above the pool minimum, the one-line
 * pricing disclosure and a link to `/pool`, with last week's impact feed under
 * the meter once a snapshot exists. Before Stripe is set up the
 * section still shows the meter and the link, with a disabled "Funding opens
 * soon". Nothing renders while the pool is off.
 */
@Component({
  selector: 'app-pool-fund-section',
  imports: [Icon, ImpactFeed, PoolMeter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:pageshow)': 'onPageShow($event)' },
  template: `
    @if (ctl.status(); as s) {
      @if (s.enabled) {
        <section
          id="fund-pool"
          class="card billing-section pool-fund"
          aria-labelledby="pool-fund-h"
        >
          <h2 id="pool-fund-h" class="billing-h">Fund the community pool</h2>
          @switch (ctl.notice()) {
            @case ('waiting') {
              <p class="notice billing-banner" role="status" aria-live="polite">
                <span class="billing-spinner" aria-hidden="true"></span>
                Payment received. Adding your credit to the pool&hellip;
              </p>
            }
            @case ('pool-funded') {
              <div class="notice billing-banner billing-banner-ok" role="status" aria-live="polite">
                <span>Thanks! Your credit is in the community pool.</span>
                <button
                  type="button"
                  class="icon-btn"
                  aria-label="Dismiss"
                  (click)="ctl.dismissNotice()"
                >
                  <app-icon name="x" [size]="14" />
                </button>
              </div>
            }
            @case ('slow') {
              <div class="notice billing-banner" role="status" aria-live="polite">
                <span>
                  Thanks! Your payment went through. The pool meter can take a few minutes to show
                  it.
                </span>
                <button
                  type="button"
                  class="icon-btn"
                  aria-label="Dismiss"
                  (click)="ctl.dismissNotice()"
                >
                  <app-icon name="x" [size]="14" />
                </button>
              </div>
            }
          }
          <app-pool-meter [status]="s" />
          <app-impact-feed />
          <p class="muted small">
            Credit in the pool lets any signed-in learner keep learning on {{ s.model.label }},
            within daily limits.
          </p>
          @if (demo) {
            <p class="muted small">Funding the pool is not available in the demo.</p>
          } @else if (s.fundingOpen) {
            <div class="billing-presets" role="group" aria-label="Amounts to fund the pool">
              @for (cents of ctl.presets(); track cents) {
                <button
                  type="button"
                  class="btn"
                  [disabled]="ctl.busy()"
                  [attr.aria-busy]="ctl.pending() === cents || null"
                  (click)="ctl.fund(cents)"
                >
                  {{ ctl.pending() === cents ? 'Opening…' : cents_(cents) }}
                </button>
              }
            </div>
          } @else {
            <div class="billing-actions">
              <button type="button" class="btn" disabled>Funding opens soon</button>
            </div>
          }
          <p class="muted small pool-fee">
            {{ note(s) }} Prices exclude tax; tax is calculated at checkout.
          </p>
          @if (ctl.actionError(); as e) {
            <p class="notice notice-error" role="alert">{{ e }}</p>
          }
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
export class PoolFundSection implements OnInit, OnDestroy {
  /** Back from a paid pool checkout (`?checkout=success&target=pool`): wait for the meter. */
  readonly funded = input(false);

  /** The demo can't buy anything. */
  protected readonly demo = inject(DEMO_MODE);
  protected readonly ctl = new PoolFundController({
    api: inject(ApiClient),
    navigate: (url) => location.assign(url),
  });

  ngOnInit(): void {
    void this.ctl.init(this.funded());
  }

  ngOnDestroy(): void {
    this.ctl.destroy();
  }

  protected onPageShow(event: Event): void {
    if ((event as PageTransitionEvent).persisted) this.ctl.resetPending();
  }

  protected note(s: PoolStatusResponse): string {
    return poolFundingNote(s.markupBps);
  }

  protected cents_(cents: number): string {
    return formatCents(cents);
  }
}
