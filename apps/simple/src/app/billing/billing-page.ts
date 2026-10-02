import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { MonthlyPlanInfo, UsageEntry, UsagePurpose } from '@tangent/shared';
import { ApiClient, BillingClient, DEMO_MODE, Icon } from '@tangent/web-shared';
import { BillingController } from './billing-controller';
import { formatBps, formatCents, formatCharge, formatMicros } from './format';

const PURPOSE_LABELS: Record<UsagePurpose, string> = {
  reply: 'Reply',
  summary: 'Summary',
  title: 'Title',
  review: 'Review',
  other: 'Other',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Payment due',
  canceled: 'Cancelled',
  incomplete: 'Incomplete',
  unpaid: 'Unpaid',
};

/**
 * `/learn/billing`: balance, top-ups, monthly plans, the Stripe customer
 * portal and recent usage. Stripe sends the browser back here with
 * `?checkout=success|cancel` (bound as the `checkout` input when the router
 * has component input binding, otherwise read from the route).
 */
@Component({
  selector: 'app-billing-page',
  imports: [DatePipe, Icon, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'billing-page', '(window:pageshow)': 'onPageShow($event)' },
  template: `
    <a class="link-btn billing-back" routerLink="/"><app-icon name="back" [size]="14" /> Lessons</a>
    <h1 class="billing-title">Billing</h1>

    @switch (ctl.notice()) {
      @case ('waiting') {
        <div class="notice billing-banner" role="status" aria-live="polite">
          <span class="billing-spinner" aria-hidden="true"></span>
          Payment received. Adding your credit&hellip;
        </div>
      }
      @case ('credited') {
        <div class="notice billing-banner billing-banner-ok" role="status" aria-live="polite">
          <span>Thanks! Your credit has been added.</span>
          <button type="button" class="icon-btn" aria-label="Dismiss" (click)="ctl.dismissNotice()">
            <app-icon name="x" [size]="14" />
          </button>
        </div>
      }
      @case ('slow') {
        <div class="notice billing-banner" role="status" aria-live="polite">
          <span>
            Thanks! Your payment went through. The credit can take a minute to appear; refresh this
            page shortly if your balance hasn't changed.
          </span>
          <button type="button" class="icon-btn" aria-label="Dismiss" (click)="ctl.dismissNotice()">
            <app-icon name="x" [size]="14" />
          </button>
        </div>
      }
      @case ('cancelled') {
        <div class="notice billing-banner" role="status">
          <span>Checkout was cancelled. You weren't charged.</span>
          <button type="button" class="icon-btn" aria-label="Dismiss" (click)="ctl.dismissNotice()">
            <app-icon name="x" [size]="14" />
          </button>
        </div>
      }
    }

    @if (ctl.summary(); as s) {
      @if (!s.enabled) {
        <p class="notice">Billing is not set up on this server.</p>
      } @else {
        <section class="card billing-section" aria-labelledby="billing-balance-h">
          <h2 id="billing-balance-h" class="billing-h">Balance</h2>
          <p class="billing-balance" [class.billing-negative]="s.balanceMicros < 0">
            {{ money(s.balanceMicros) }}
          </p>
          @if (s.heldMicros > 0) {
            <p class="muted small">
              {{ money(s.heldMicros) }} is held for in-flight replies, so
              {{ money(s.availableMicros) }} is available right now.
            </p>
          }
          <p class="muted small">
            Each reply costs the model's price, including the provider's credit-purchase fee, plus
            10% (5% with a monthly plan). Payment processing fees are deducted from each purchase,
            so the credit added is slightly less than the amount paid. Prices exclude tax; tax is
            calculated at checkout.
          </p>
          @if (s.lastPurchase; as p) {
            <p class="muted small billing-last-purchase">
              Last {{ p.kind === 'subscription' ? 'plan payment' : 'top-up' }}: paid
              {{ money(p.grossMicros) }}, credit {{ money(p.creditMicros) }} after payment
              processing.
            </p>
          }
          <p class="muted small">
            You're paying the {{ bps(s.markupBps) }} rate right now. The rate follows your plan when
            a reply is sent, including for credit you added earlier.
          </p>
        </section>

        <section class="card billing-section" aria-labelledby="billing-topup-h">
          <h2 id="billing-topup-h" class="billing-h">Add credit</h2>
          @if (demo) {
            <p class="muted small">Adding credit is not available in the demo.</p>
          } @else if (s.topUpsEnabled === false) {
            <p class="muted small">One-time top-ups aren't available on this server right now.</p>
          } @else {
            <div class="billing-presets" role="group" aria-label="Top-up amounts">
              @for (cents of ctl.presets(); track cents) {
                <button
                  type="button"
                  class="btn"
                  [disabled]="ctl.busy()"
                  [attr.aria-busy]="isPendingTopUp(cents) || null"
                  (click)="ctl.topUp(cents)"
                >
                  {{ isPendingTopUp(cents) ? 'Opening…' : cents_(cents) }}
                </button>
              }
            </div>
            <form
              class="billing-custom"
              novalidate
              (submit)="$event.preventDefault(); ctl.topUpCustom()"
            >
              <label class="field">
                <span class="field-label">
                  Other amount ({{ cents_(ctl.minCents()) }} to {{ cents_(ctl.maxCents()) }})
                </span>
                <span class="billing-amount">
                  <span class="billing-currency" aria-hidden="true">$</span>
                  <input
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    placeholder="25.00"
                    [value]="ctl.customInput()"
                    [attr.aria-invalid]="showCustomError() ? 'true' : null"
                    [attr.aria-describedby]="showCustomError() ? 'billing-custom-err' : null"
                    (input)="ctl.setCustomInput(inputValue($event))"
                  />
                </span>
              </label>
              <button type="submit" class="btn btn-primary" [disabled]="ctl.busy()">
                {{ customPending() ? 'Opening…' : 'Add credit' }}
              </button>
            </form>
            @if (showCustomError()) {
              <p id="billing-custom-err" class="small billing-error">{{ ctl.customError() }}</p>
            }
          }
        </section>

        @if (s.monthlyPlans.length > 0 && !demo) {
          <section class="billing-section" aria-labelledby="billing-plans-h">
            <h2 id="billing-plans-h" class="billing-h">Monthly plans</h2>
            <p class="muted small">
              A plan adds its amount as credit every month, less payment processing fees, and every
              reply is charged at the 5% rate while it's active. Unused credit rolls over.
            </p>
            <ul class="billing-plans">
              @for (plan of s.monthlyPlans; track plan.name) {
                @let current = isCurrent(plan);
                <li class="card billing-plan" [class.billing-plan-current]="current">
                  <div class="billing-plan-head">
                    <strong>{{ plan.label }}</strong>
                    @if (current) {
                      <span class="badge badge-ok">Your plan</span>
                    }
                  </div>
                  <p class="billing-plan-price">
                    {{ cents_(plan.amountCents) }}<span class="muted small"> / month</span>
                  </p>
                  <p class="muted small">
                    Credit added every month (after processing fees), at the 5% rate.
                  </p>
                  @if (current) {
                    @if (ctl.currentPlan(); as sub) {
                      <p class="small">
                        <span class="badge" [class.badge-warn]="sub.status !== 'active'">{{
                          statusLabel(sub.status)
                        }}</span>
                        @if (sub.periodEnd) {
                          @if (sub.cancelAtPeriodEnd) {
                            Ends on {{ sub.periodEnd | date: 'mediumDate' }}
                          } @else {
                            Renews on {{ sub.periodEnd | date: 'mediumDate' }}
                          }
                        } @else if (sub.cancelAtPeriodEnd) {
                          Ends at the end of this period
                        }
                      </p>
                    }
                  } @else {
                    <button
                      type="button"
                      class="btn"
                      [disabled]="ctl.busy()"
                      [attr.aria-label]="
                        (ctl.currentPlan() ? 'Switch to ' : 'Choose ') + plan.label
                      "
                      (click)="ctl.choosePlan(plan)"
                    >
                      {{
                        isPendingPlan(plan)
                          ? 'Opening…'
                          : ctl.currentPlan()
                            ? 'Switch to this plan'
                            : 'Choose'
                      }}
                    </button>
                  }
                </li>
              }
            </ul>
          </section>
        }

        <section class="billing-section billing-manage" aria-labelledby="billing-manage-h">
          <h2 id="billing-manage-h" class="sr-only">Manage billing</h2>
          <button type="button" class="btn" [disabled]="demo || ctl.busy()" (click)="ctl.manage()">
            <app-icon name="external" [size]="14" />
            {{ ctl.pending()?.kind === 'portal' ? 'Opening…' : 'Manage billing' }}
          </button>
          @if (demo) {
            <span class="muted small">Not available in the demo.</span>
          } @else {
            <span class="muted small"
              >Payment methods, invoices, and changing or cancelling your plan.</span
            >
          }
        </section>

        @if (ctl.actionError(); as e) {
          <p class="notice notice-error" role="alert">{{ e }}</p>
        }

        <section class="billing-section" aria-labelledby="billing-usage-h">
          <h2 id="billing-usage-h" class="billing-h">Recent usage</h2>
          @if (ctl.usageLoaded() && ctl.usage().length === 0) {
            <p class="muted small">Nothing yet. Charges for replies show up here.</p>
          } @else if (ctl.usage().length > 0) {
            <div
              class="billing-table-wrap"
              tabindex="0"
              role="region"
              aria-labelledby="billing-usage-h"
            >
              <table class="billing-table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">For</th>
                    <th scope="col">Model</th>
                    <th scope="col" class="billing-num">Charge</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  @for (u of ctl.usage(); track u.id) {
                    <tr>
                      <td class="billing-nowrap">{{ u.createdAt | date: 'MMM d, h:mm a' }}</td>
                      <td>{{ purposeLabel(u) }}</td>
                      <td class="billing-model">{{ u.model }}</td>
                      <td class="billing-num">
                        {{ u.chargeMicros === null ? '—' : charge(u.chargeMicros) }}
                      </td>
                      <td>
                        <span
                          class="badge"
                          [class.badge-ok]="u.status === 'settled'"
                          [class.badge-warn]="u.status === 'pending'"
                          >{{ usageStatus(u) }}</span
                        >
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else if (ctl.usageLoading()) {
            <p class="muted small">Loading…</p>
          }
          @if (ctl.usageError(); as e) {
            <p class="notice notice-error" role="alert">
              {{ e }}
              <button type="button" class="btn btn-sm" (click)="ctl.loadUsage(!ctl.usageLoaded())">
                Retry
              </button>
            </p>
          }
          @if (ctl.usageCursor() && !ctl.usageError()) {
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              [disabled]="ctl.usageLoading()"
              (click)="ctl.loadUsage()"
            >
              {{ ctl.usageLoading() ? 'Loading…' : 'Load more' }}
            </button>
          }
        </section>
      }
    } @else if (ctl.loadError(); as e) {
      <p class="notice notice-error" role="alert">
        {{ e }}
        <button type="button" class="btn btn-sm" [disabled]="ctl.loading()" (click)="ctl.load()">
          Retry
        </button>
      </p>
    } @else {
      <p class="muted">Loading…</p>
    }
  `,
  styles: `
    :host {
      display: block;
      max-width: 720px;
      margin: 0 auto;
      padding: 16px 16px 48px;
    }
    .billing-back {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .billing-title {
      margin: 8px 0 12px;
      font-size: 1.5rem;
    }
    .billing-h {
      margin: 0 0 4px;
      font-size: 1.05rem;
    }
    .billing-section {
      margin: 16px 0;
    }
    .billing-section p {
      margin: 4px 0;
    }
    .billing-balance {
      font-size: 2rem;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .billing-negative {
      color: var(--danger);
    }
    .billing-banner {
      justify-content: space-between;
      flex-wrap: nowrap;
    }
    .billing-banner-ok {
      background: var(--ok-soft);
    }
    .billing-spinner {
      flex: none;
      width: 14px;
      height: 14px;
      border: 2px solid var(--border-strong);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: billing-spin 0.8s linear infinite;
    }
    @keyframes billing-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .billing-spinner {
        animation: none;
      }
    }
    .billing-presets {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
      gap: 8px;
      margin: 8px 0 12px;
    }
    .billing-custom {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 8px;
    }
    .billing-custom .field {
      flex: 1 1 180px;
    }
    .billing-amount {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .billing-amount input {
      flex: 1;
      min-width: 0;
    }
    .billing-currency {
      color: var(--fg-muted);
    }
    .billing-error {
      color: var(--danger);
    }
    .billing-plans {
      list-style: none;
      padding: 0;
      margin: 8px 0 0;
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    }
    .billing-plan {
      align-items: flex-start;
    }
    .billing-plan-current {
      border-color: var(--accent);
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    .billing-plan-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .billing-plan-price {
      font-size: 1.25rem;
      font-weight: 600;
    }
    .billing-manage {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .billing-table-wrap {
      overflow-x: auto;
      margin: 8px 0;
    }
    .billing-table-wrap:focus-visible {
      outline: none;
      box-shadow: var(--focus);
    }
    .billing-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
    }
    .billing-table th,
    .billing-table td {
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
    }
    .billing-table th {
      color: var(--fg-muted);
      font-weight: 600;
    }
    .billing-num {
      text-align: right !important;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .billing-nowrap {
      white-space: nowrap;
    }
    .billing-model {
      word-break: break-all;
      font-family: var(--mono);
      font-size: 0.78rem;
    }
  `,
})
export class BillingPage implements OnInit, OnDestroy {
  /** `?checkout=success|cancel` when the router binds query params to inputs. */
  readonly checkout = input<string | undefined>();

  /** The demo can't buy anything: top-ups, plans and the portal are off. */
  protected readonly demo = inject(DEMO_MODE);
  private readonly route = inject(ActivatedRoute, { optional: true });
  private readonly router = inject(Router, { optional: true });

  protected readonly ctl = new BillingController({
    api: inject(ApiClient),
    billing: inject(BillingClient),
    navigate: (url) => location.assign(url),
    clearCheckoutParam: () => this.clearCheckoutParam(),
  });

  ngOnInit(): void {
    const checkout = this.checkout() ?? this.route?.snapshot.queryParamMap.get('checkout');
    void this.ctl.init(checkout);
  }

  ngOnDestroy(): void {
    this.ctl.destroy();
  }

  protected onPageShow(event: Event): void {
    // Back from Stripe through the back/forward cache: the page never reloaded.
    if ((event as PageTransitionEvent).persisted) this.ctl.resetPending();
  }

  protected money(micros: number): string {
    return formatMicros(micros);
  }

  protected charge(micros: number): string {
    return formatCharge(micros);
  }

  protected cents_(cents: number): string {
    return formatCents(cents);
  }

  protected bps(bps: number): string {
    return formatBps(bps);
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected showCustomError(): boolean {
    return this.ctl.customTouched() && this.ctl.customError() !== null;
  }

  protected isPendingTopUp(cents: number): boolean {
    const p = this.ctl.pending();
    return p?.kind === 'top-up' && p.source === 'preset' && p.cents === cents;
  }

  protected customPending(): boolean {
    const p = this.ctl.pending();
    return p?.kind === 'top-up' && p.source === 'custom';
  }

  protected isPendingPlan(plan: MonthlyPlanInfo): boolean {
    const p = this.ctl.pending();
    return p?.kind === 'plan' && p.plan === plan.name;
  }

  protected isCurrent(plan: MonthlyPlanInfo): boolean {
    return this.ctl.currentPlan()?.plan === plan.name;
  }

  protected statusLabel(status: string): string {
    return STATUS_LABELS[status] ?? status;
  }

  protected purposeLabel(u: UsageEntry): string {
    return PURPOSE_LABELS[u.purpose] ?? u.purpose;
  }

  protected usageStatus(u: UsageEntry): string {
    if (u.status === 'pending') return 'In progress';
    if (u.status === 'unresolved') return 'Not charged';
    return 'Charged';
  }

  private clearCheckoutParam(): void {
    if (this.router && this.route) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { checkout: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
      return;
    }
    const url = new URL(location.href);
    url.searchParams.delete('checkout');
    history.replaceState(history.state, '', url);
  }
}
