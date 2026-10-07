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
 * code, the billing page or sign out. The membership is what lets the user
 * generate on their own API keys, so that is all the gate sells; `needs`
 * says what needs it (using their own API keys, by default).
 * There is no close button on purpose; the app behind it should be `inert`
 * meanwhile. `alternative` labels a button that carries on without a
 * membership instead (Learn: the open pool, or Tangent credit, which anyone
 * can buy). Not shown on the billing page, the login page or in the demos
 * (the app decides). Only Learn shows it today.
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
      <h2 [id]="titleId" class="membership-gate-title">Your own keys: {{ price() }} a year</h2>
      <div [id]="descId" class="membership-gate-desc">
        <p>
          The yearly membership is what lets you use your own API keys: your provider bills you for
          the models, and the membership covers Tangent. {{ needs() }}; Tangent credit doesn't, and
          your conversations stay readable without it.
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
      @if (alternative(); as label) {
        <button type="button" class="btn membership-gate-alt" (click)="alternativeChosen.emit()">
          {{ label }}
        </button>
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
  /** What needs the membership, as a clause without its full stop ("…; Tangent credit doesn't"). */
  readonly needs = input('Using your own API keys needs one');
  /**
   * The label of a button that carries on without a membership instead of
   * subscribing ("Continue on the open pool", "Continue on Tangent credit");
   * null offers none.
   */
  readonly alternative = input<string | null>(null);
  /** A code waived the fee: the new membership (status `waived`). */
  readonly redeemed = output<MembershipInfo>();
  /** The user chose to carry on without a membership (`alternative`). */
  readonly alternativeChosen = output();

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
