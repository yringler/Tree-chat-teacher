import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import type { MembershipInfo } from '@tangent/shared';
import { AuthService } from '../core/auth';
import { BillingClient } from '../core/billing-client';
import { formatCents } from './format';
import { includedCreditText, MembershipSubscribe } from './membership';
import { MembershipCodeForm } from './membership-code-form';

let uid = 0;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), summary';

/**
 * Blocks the app while generating needs a membership the user doesn't have
 * (`membershipBlocks`, or a 402 `membership_required`): Subscribe, a code,
 * the billing page or sign out. There is no close button on purpose; the app
 * behind it should be `inert` meanwhile. Not shown on the billing page, the
 * login page or in the demos (the app decides).
 */
@Component({
  selector: 'app-membership-gate',
  imports: [MembershipCodeForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'membership-gate', '(window:pageshow)': 'onPageShow($event)' },
  template: `
    <section
      class="membership-gate-panel"
      role="dialog"
      aria-modal="true"
      [attr.aria-labelledby]="titleId"
      [attr.aria-describedby]="descId"
      (keydown)="trapFocus($event)"
    >
      <p class="membership-gate-brand">{{ appName() }}</p>
      <h2 [id]="titleId" class="membership-gate-title">Tangent is {{ price() }} a year</h2>
      <div [id]="descId" class="membership-gate-desc">
        <p>
          A yearly membership keeps Tangent running. New replies need one; your conversations stay
          readable without it.
        </p>
        @if (included(); as text) {
          <p>{{ text }}</p>
        }
        <p class="muted small">Plus tax, calculated at checkout. Cancel any time.</p>
      </div>
      <button
        type="button"
        class="btn btn-primary membership-gate-subscribe"
        [disabled]="sub.pending()"
        (click)="sub.subscribe()"
      >
        {{ sub.pending() ? 'Opening…' : 'Subscribe' }}
      </button>
      @if (sub.error(); as e) {
        <p class="notice notice-error" role="alert">{{ e }}</p>
      }
      <app-membership-code-form (redeemed)="redeemed.emit($event)" />
      <p class="membership-gate-links small">
        <a [href]="billingPath()">See billing</a>
        <button type="button" class="link-btn" (click)="signOut()">Sign out</button>
      </p>
    </section>
  `,
})
export class MembershipGate {
  readonly membership = input.required<MembershipInfo>();
  /** The app's absolute billing path (`/learn/billing`, `/billing`): Stripe comes back there. */
  readonly billingPath = input.required<string>();
  /** Shown above the heading, e.g. "Tangent Learn". */
  readonly appName = input('Tangent');
  /** A code waived the fee: the new membership (status `waived`). */
  readonly redeemed = output<MembershipInfo>();

  protected readonly titleId = `membership-gate-title-${++uid}`;
  protected readonly descId = `membership-gate-desc-${uid}`;
  protected readonly price = computed(() => formatCents(this.membership().priceCents));
  protected readonly included = computed(() => includedCreditText(this.membership()));
  protected readonly sub = new MembershipSubscribe(inject(BillingClient), () => this.billingPath());

  private readonly auth = inject(AuthService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    afterNextRender(() => {
      this.host.nativeElement.querySelector<HTMLElement>('.membership-gate-subscribe')?.focus();
    });
  }

  protected signOut(): void {
    void this.auth.signOut();
  }

  protected onPageShow(event: Event): void {
    // Back from Stripe through the back/forward cache: the page never reloaded.
    if ((event as PageTransitionEvent).persisted) this.sub.reset();
  }

  /** Tab and Shift+Tab cycle inside the panel. */
  protected trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const items = [...this.host.nativeElement.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.getClientRects().length > 0,
    );
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
