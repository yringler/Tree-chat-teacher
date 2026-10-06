import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { BillingSummary, MembershipInfo, UsageEntry, UsagePurpose } from '@tangent/shared';
import { ApiClient } from '../core/api-client';
import { BillingClient } from '../core/billing-client';
import { DEMO_MODE } from '../core/demo';
import { Icon } from '../ui/icon';
import { BillingController } from './billing-controller';
import { BILLING_SUMMARY_LISTENER } from './billing-listener';
import { formatCents, formatCharge, formatMicros } from './format';
import {
  creditFeeText,
  includedCreditText,
  membershipBlocks,
  membershipPriceText,
  membershipStatusText,
} from './membership';
import { MembershipCodeForm } from './membership-code-form';
import { PoolSection } from '../pool/pool-section';

const PURPOSE_LABELS: Record<UsagePurpose, string> = {
  reply: 'Reply',
  summary: 'Summary',
  title: 'Title',
  review: 'Review',
  tagging: 'Topic tag',
  other: 'Other',
};

/**
 * The billing page of both apps (`/learn/billing`, `/billing`): the yearly
 * membership, credit for the built-in provider (balance, top-ups, recent
 * usage), the payment provider's billing portal, and the community pool's
 * meter (PoolSection; nothing to buy there); each section only where it
 * applies. The checkout sends the browser back with `?checkout=success|cancel`
 * (bound as the `checkout` input when the router has component input binding,
 * otherwise read from the route). Styles: `.billing-*` in base.css.
 */
@Component({
  selector: 'app-billing-page',
  imports: [DatePipe, Icon, MembershipCodeForm, PoolSection, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'billing-page', '(window:pageshow)': 'onPageShow($event)' },
  template: `
    <a class="link-btn billing-back" [routerLink]="homePath()"
      ><app-icon name="back" [size]="14" /> {{ homeLabel() }}</a
    >
    <h1 class="billing-title">Billing</h1>

    @switch (ctl.notice()) {
      @case ('waiting') {
        <div class="notice billing-banner" role="status" aria-live="polite">
          <span class="billing-spinner" aria-hidden="true"></span>
          Payment received. Updating your account&hellip;
        </div>
      }
      @case ('activated') {
        <div class="notice billing-banner billing-banner-ok" role="status" aria-live="polite">
          <span>Thanks! Your membership is active.</span>
          <button type="button" class="icon-btn" aria-label="Dismiss" (click)="ctl.dismissNotice()">
            <app-icon name="x" [size]="14" />
          </button>
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
            Thanks! Your payment went through. It can take a minute to show here; refresh this page
            shortly if nothing has changed.
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
        @if (s.membership.required) {
          <section class="card billing-section" aria-labelledby="billing-membership-h">
            <h2 id="billing-membership-h" class="billing-h">Membership</h2>
            <p class="billing-status">{{ statusText(s.membership) }}</p>
            <p class="muted small">
              {{ priceText(s.membership) }}
              @if (includedText(s); as included) {
                · {{ included }}
              }
            </p>
            @if (s.membership.status === 'inactive' || s.membership.subscriptionStatus) {
              <div class="billing-actions">
                @if (s.membership.status === 'inactive') {
                  <button
                    type="button"
                    class="btn btn-primary"
                    [disabled]="demo || ctl.busy()"
                    (click)="ctl.subscribe()"
                  >
                    {{ ctl.pending()?.kind === 'subscribe' ? 'Opening…' : 'Subscribe' }}
                  </button>
                }
                @if (s.membership.subscriptionStatus) {
                  <button
                    type="button"
                    class="btn"
                    [disabled]="demo || ctl.busy()"
                    (click)="ctl.manage()"
                  >
                    <app-icon name="external" [size]="14" />
                    {{ ctl.pending()?.kind === 'portal' ? 'Opening…' : 'Manage billing' }}
                  </button>
                }
              </div>
            }
            @if (s.membership.status === 'inactive' && !demo) {
              <app-membership-code-form (redeemed)="onRedeemed($event)" />
            }
          </section>
        }

        @if (s.builtInCredit) {
          <section class="card billing-section" aria-labelledby="billing-balance-h">
            <h2 id="billing-balance-h" class="billing-h">Credit</h2>
            <p class="billing-balance" [class.billing-negative]="s.balanceMicros < 0">
              {{ money(s.balanceMicros) }}
            </p>
            @if (s.heldMicros > 0) {
              <p class="muted small">
                {{ money(s.heldMicros) }} is held for replies in progress, so
                {{ money(s.availableMicros) }} is available right now.
              </p>
            }
            <p class="muted small">Each call costs {{ feeText(s) }}.</p>
            @if (s.lastPurchase; as p) {
              <p class="muted small billing-last-purchase">
                Last {{ p.kind === 'subscription' ? 'plan payment' : 'top-up' }}: paid
                {{ money(p.grossMicros) }}, credit {{ money(p.creditMicros) }} after payment
                processing.
              </p>
            }
          </section>

          <section class="card billing-section" aria-labelledby="billing-topup-h">
            <h2 id="billing-topup-h" class="billing-h">Add credit</h2>
            @if (demo) {
              <p class="muted small">Adding credit is not available in the demo.</p>
            } @else if (s.topUpsEnabled === false) {
              <p class="muted small">One-time top-ups aren't available on this server right now.</p>
            } @else if (membersOnly(s)) {
              <p class="muted small billing-members-only">
                Buying credit is for members: subscribe above to add more. Credit you already have
                stays spendable.
              </p>
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
              <p class="muted small">
                Payment processing fees are deducted from each top-up, so the credit added is
                slightly less than the amount paid. Prices exclude tax; tax is calculated at
                checkout.
              </p>
            }
          </section>

          @if (!(s.membership.required && s.membership.subscriptionStatus)) {
            <section class="billing-section billing-actions" aria-labelledby="billing-manage-h">
              <h2 id="billing-manage-h" class="sr-only">Manage billing</h2>
              <button
                type="button"
                class="btn"
                [disabled]="demo || ctl.busy()"
                (click)="ctl.manage()"
              >
                <app-icon name="external" [size]="14" />
                {{ ctl.pending()?.kind === 'portal' ? 'Opening…' : 'Manage billing' }}
              </button>
              <span class="muted small">
                {{ demo ? 'Not available in the demo.' : 'Payment methods and invoices.' }}
              </span>
            </section>
          }
        } @else if (!s.membership.required) {
          <p class="notice">Nothing on this server requires payment.</p>
        }

        @if (ctl.actionError(); as e) {
          <p class="notice notice-error" role="alert">{{ e }}</p>
        }

        @if (s.builtInCredit || ctl.usage().length > 0) {
          <section class="billing-section" aria-labelledby="billing-usage-h">
            <h2 id="billing-usage-h" class="billing-h">Recent usage</h2>
            @if (ctl.usageLoaded() && ctl.usage().length === 0) {
              <p class="muted small">Nothing yet. Charges for replies on credit show up here.</p>
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
                <button
                  type="button"
                  class="btn btn-sm"
                  (click)="ctl.loadUsage(!ctl.usageLoaded())"
                >
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

    <app-pool-section />
  `,
})
export class BillingPage implements OnInit, OnDestroy {
  /** Router link of the app's start page (the back link), e.g. `/`. */
  readonly homePath = input('/');
  /** Label of the back link, e.g. "Lessons" or "Conversations". */
  readonly homeLabel = input('Home');
  /**
   * The app's absolute path of this page (`/learn/billing`, `/billing`). The
   * server sends the payment provider's pages back here (it knows the app
   * from the request), so this only documents where the page lives.
   */
  readonly billingPath = input('/billing');
  /** `?checkout=success|cancel` when the router binds query params to inputs. */
  readonly checkout = input<string | undefined>();

  /** The demo can't buy anything: top-ups, Subscribe and the portal are off. */
  protected readonly demo = inject(DEMO_MODE);
  private readonly route = inject(ActivatedRoute, { optional: true });
  private readonly router = inject(Router, { optional: true });

  protected readonly ctl = new BillingController({
    api: inject(ApiClient),
    billing: inject(BillingClient),
    navigate: (url) => location.assign(url),
    clearCheckoutParam: () => this.clearCheckoutParam(),
  });

  constructor() {
    const listener = inject(BILLING_SUMMARY_LISTENER, { optional: true });
    if (listener) {
      effect(() => {
        const summary = this.ctl.summary();
        if (summary) listener(summary);
      });
    }
  }

  ngOnInit(): void {
    const checkout = this.checkout() ?? this.route?.snapshot.queryParamMap.get('checkout');
    void this.ctl.init(checkout);
  }

  ngOnDestroy(): void {
    this.ctl.destroy();
  }

  protected onPageShow(event: Event): void {
    // Back from the checkout through the back/forward cache: the page never reloaded.
    if ((event as PageTransitionEvent).persisted) this.ctl.resetPending();
  }

  protected onRedeemed(membership: MembershipInfo): void {
    this.ctl.setMembership(membership);
  }

  protected statusText(m: MembershipInfo): string {
    return membershipStatusText(m);
  }

  protected priceText(m: MembershipInfo): string {
    return membershipPriceText(m);
  }

  /** Buying credit needs the membership the user lacks (the server answers 402); spending doesn't. */
  protected membersOnly(s: BillingSummary): boolean {
    return membershipBlocks(s.membership);
  }

  /** The yearly credit is only promised where credit can be spent. */
  protected includedText(s: BillingSummary): string | null {
    return s.builtInCredit ? includedCreditText(s.membership) : null;
  }

  protected feeText(s: BillingSummary): string {
    return creditFeeText(s.markupBps, s.openRouterFeeBps);
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

  protected purposeLabel(u: UsageEntry): string {
    const label = PURPOSE_LABELS[u.purpose] ?? u.purpose;
    // The search fee is inside the call's charge (OpenRouter reports one cost).
    return u.webSearches > 0 ? `${label} + web search` : label;
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
