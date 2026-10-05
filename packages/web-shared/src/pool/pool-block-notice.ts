import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../ui/icon';
import { poolBlockText, type PoolBlock } from './pool-format';

/**
 * The inline state of a message the community pool refused (spec §8), shown
 * in the chat above the composer, never as a generic error toast:
 * - empty: "The community pool is empty. It refills as people fund it." with
 *   **Fund the pool** and **Buy personal credits**;
 * - a cap: the cap, when it resets, and that supporters get more.
 * The message itself is kept in the composer. While funding isn't open yet
 * (no Stripe), nothing can be bought: the empty state says funding opens
 * soon and links to `/pool`, which explains the pool.
 */
@Component({
  selector: 'app-pool-block-notice',
  imports: [Icon, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pool-block" [class.pool-block-empty]="block().kind === 'empty'" role="status">
      <div class="pool-block-text">
        <p class="pool-block-title">{{ text().title }}</p>
        @if (text().detail; as detail) {
          <p class="muted small">{{ detail }}</p>
        }
        @if (text().supporters; as supporters) {
          <p class="muted small">{{ supporters }}</p>
        }
        @if (block().kind === 'empty' && block().details.reason === 'empty') {
          <div class="pool-block-actions">
            @if (fundingOpen()) {
              <a class="btn btn-primary btn-sm" [routerLink]="billingPath()" fragment="fund-pool"
                >Fund the pool</a
              >
              <a class="btn btn-sm" [routerLink]="billingPath()">Buy personal credits</a>
            } @else {
              <span class="muted small">Funding opens soon.</span>
              <a class="btn btn-sm" href="/pool">How the pool works</a>
            }
          </div>
        } @else if (text().supporters && fundingOpen()) {
          <div class="pool-block-actions">
            <a class="btn btn-sm" [routerLink]="billingPath()">Buy credits</a>
          </div>
        }
      </div>
      <button type="button" class="icon-btn" aria-label="Dismiss" (click)="dismissed.emit()">
        <app-icon name="x" [size]="14" />
      </button>
    </div>
  `,
})
export class PoolBlockNotice {
  readonly block = input.required<PoolBlock>();
  /** Stripe is set up, so the pool and personal credit can be bought now. */
  readonly fundingOpen = input(false);
  /** Router link of the app's billing page (`/billing`). */
  readonly billingPath = input('/billing');
  readonly dismissed = output();

  protected readonly text = computed(() => poolBlockText(this.block()));
}
