import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DEMO_MODE, formatMicros, Icon } from '@tangent/web-shared';
import { AccountStore } from '../state/account-store';
import { UiStore } from '../state/ui-store';

/**
 * What replies run on (the learner's own OpenRouter key, Tangent credit or
 * the open pool), as a button that opens "How replies are paid for".
 * `header` is the app header's pill ("Credit · $1.20", the amount hidden on
 * phones); `inline` sits next to Start lesson ("Replies paid by [Tangent
 * credit · $1.20 left  Change]"). The demo has no such dialog (it always runs on its pretend credit): the header pill
 * links to billing there, and the inline one is plain text.
 */
@Component({
  selector: 'app-paid-by',
  imports: [Icon, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let p = account.paidBy();
    @if (variant() === 'header') {
      @if (demo) {
        @if (p.detail) {
          <a
            routerLink="/billing"
            class="balance-pill"
            [class.balance-low]="p.warn"
            [attr.aria-label]="'Replies paid by ' + description() + '. Open billing'"
            title="Credit left · Billing"
          >
            {{ headerName() }} · {{ headerAmount() }}
          </a>
        }
      } @else {
        <button
          type="button"
          class="pay-pill"
          [class.balance-low]="p.warn"
          [attr.aria-label]="
            'Replies paid by ' + description() + '. Change how replies are paid for'
          "
          title="How replies are paid for"
          (click)="open()"
        >
          <span
            >{{ headerName() }}
            @if (headerAmount(); as amount) {
              <span class="hide-narrow"> · {{ amount }}</span>
            }
          </span>
          <app-icon name="chevronDown" [size]="14" />
        </button>
      }
    } @else {
      <span class="paid-by">
        <span class="muted small">Replies paid by</span>
        @if (demo) {
          <strong class="small">{{ p.label }}</strong>
        } @else {
          <button
            type="button"
            class="pay-pill"
            [class.balance-low]="p.warn"
            [attr.aria-label]="description() + '. Change how replies are paid for'"
            title="How replies are paid for"
            (click)="open()"
          >
            <span
              ><strong>{{ p.label }}</strong>
              @if (p.detail) {
                <span class="pay-detail"> · {{ p.detail }}</span>
              }
            </span>
            <span class="pay-change">Change</span>
          </button>
        }
      </span>
    }
  `,
})
export class PaidBy {
  readonly variant = input<'header' | 'inline'>('inline');
  protected readonly account = inject(AccountStore);
  private readonly ui = inject(UiStore);
  protected readonly demo = inject(DEMO_MODE);

  /** The header pill's name: "Credit", "Pool", "Your key" or "Add your key". */
  protected readonly headerName = computed(() => {
    const p = this.account.paidBy();
    return p.payment === 'own-key' && p.warn ? 'Add your key' : p.short;
  });

  /** The header pill's amount (hidden on narrow screens): the credit or the pool's dollars. */
  protected readonly headerAmount = computed(() => {
    const p = this.account.paidBy();
    if (p.payment === 'credit') return this.account.balanceText();
    const status = this.account.poolStatus();
    return p.payment === 'pool' && status?.enabled ? formatMicros(status.availableMicros) : null;
  });

  /** "Tangent credit, $1.20 left", for screen readers. */
  protected readonly description = computed(() => {
    const p = this.account.paidBy();
    return p.detail ? `${p.label}, ${p.detail}` : p.label;
  });

  protected open(): void {
    this.ui.menuOpen.set(false);
    this.ui.accessOpen.set(true);
  }
}
