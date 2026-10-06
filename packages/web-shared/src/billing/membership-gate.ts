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
 * Blocks the app while what the user is doing needs a membership they don't
 * have (`membershipBlocks`, or a 402 `membership_required`): Subscribe, a
 * code, the billing page or sign out. `needs` says what needs it (power mode
 * on the user's own keys, by default). There is no close button on purpose;
 * the app behind it should be `inert` meanwhile. `freeTier` labels a button
 * that carries on without a membership instead (Learn on the open pool
 * or the user's own key; power on Tangent credit the user still holds), and
 * `learnHref` links to Learn, free on the user's own key (the power app's way
 * out). Not shown on the billing page, the login page or in the demos (the
 * app decides).
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
          A yearly membership keeps Tangent running. {{ needs() }}; your conversations stay readable
          without it.
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
      @if (freeTier(); as label) {
        <button type="button" class="btn membership-gate-free" (click)="freeTierChosen.emit()">
          {{ label }}
        </button>
      }
      @if (learnHref(); as href) {
        <a class="btn membership-gate-learn" [href]="href"
          >Use Learn instead (free with your own key)</a
        >
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
  /** The app's absolute billing path (`/learn/billing`, `/billing`), for the "See billing" link. */
  readonly billingPath = input.required<string>();
  /** Shown above the heading, e.g. "Tangent Learn". */
  readonly appName = input('Tangent');
  /** What needs the membership, as a sentence without its full stop. */
  readonly needs = input('Power mode on your own keys needs one');
  /**
   * The label of a button that carries on without a membership instead of
   * subscribing (Learn on the open pool or the user's own key; power on
   * Tangent credit the user still holds); null offers none.
   */
  readonly freeTier = input<string | null>(null);
  /** The Learn app's address (`/learn/`), offered as a free way out; null offers none. */
  readonly learnHref = input<string | null>(null);
  /** A code waived the fee: the new membership (status `waived`). */
  readonly redeemed = output<MembershipInfo>();
  /** The user chose the free tier (`freeTier`). */
  readonly freeTierChosen = output();

  protected readonly titleId = `membership-gate-title-${++uid}`;
  protected readonly descId = `membership-gate-desc-${uid}`;
  protected readonly price = computed(() => formatCents(this.membership().priceCents));
  protected readonly included = computed(() => includedCreditText(this.membership()));
  protected readonly sub = new MembershipSubscribe(inject(BillingClient));

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
    // Back from the checkout through the back/forward cache: the page never reloaded.
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
