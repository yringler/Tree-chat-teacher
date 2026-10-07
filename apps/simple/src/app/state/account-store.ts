import { computed, inject, Injectable, signal } from '@angular/core';
import {
  LEARN_KEY_PROVIDER,
  type BillingSummary,
  type KeyStatusResponse,
  type LearnPayment,
  type MembershipInfo,
  type MeResponse,
  type PoolMeResponse,
  type PoolStatusResponse,
} from '@tangent/shared';
import { ApiClient, DEMO_MODE, formatMicros, membershipBlocks } from '@tangent/web-shared';
import { PaymentStore } from './payment-store';
import { UiStore } from './ui-store';

/** What Learn's replies run on right now, for the header and the New lesson form. */
export interface PaidBy {
  readonly payment: LearnPayment;
  /** "Your OpenRouter key", "Tangent credit" or "Open pool". */
  readonly label: string;
  /** The header's shorter name: "Your key", "Credit" or "Pool". */
  readonly short: string;
  /** "$1.20 left", "$2.40 in the pool" or "no key saved"; null when there is nothing to add. */
  readonly detail: string | null;
  /** Replies can't run on it now (no key, no credit, the pool or today's share used up). */
  readonly warn: boolean;
}

/**
 * The signed-in caller, their membership (needed only for replies on their
 * own key), how they pay (own key, credit or the open pool), their credit
 * balance and the pool's meter.
 */
@Injectable({ providedIn: 'root' })
export class AccountStore {
  private readonly api = inject(ApiClient);
  readonly payment = inject(PaymentStore);
  private readonly ui = inject(UiStore);

  readonly me = signal<MeResponse | null>(null);
  /** Null until loaded, or when billing can't be read (the pill is hidden then). */
  readonly billing = signal<BillingSummary | null>(null);
  /** From /api/me, then from every billing summary and redeemed code; null until loaded. */
  readonly membership = signal<MembershipInfo | null>(null);
  /** The key cookie's state; null until loaded (and in the demo, which has no keys). */
  readonly keyStatus = signal<KeyStatusResponse | null>(null);
  /** The open pool's meter; null until loaded or when it can't be read. */
  readonly poolStatus = signal<PoolStatusResponse | null>(null);
  /** The learner's caps and use of the pool today; null until loaded, or while the pool is off. */
  readonly poolMe = signal<PoolMeResponse | null>(null);
  private readonly demo = inject(DEMO_MODE, { optional: true }) ?? false;

  /** The server refused a reply for want of a membership (402 `membership_required`). */
  private readonly gateForced = signal(false);

  /**
   * Replies can't run on the own key: the learner has no membership where one
   * is required, and replies run on their own key (which needs one; the pool
   * and Tangent credit don't), or the server just refused a reply with 402
   * `membership_required` (the membership may have lapsed since /api/me).
   * The lesson stays readable; `KeyLockedNotice` stands where the composer
   * (and the new lesson's Start button) would be, with the ways out:
   * subscribe, or `continueOn` the pool or credit (`keyLockedWays`).
   */
  readonly membershipBlocked = computed(
    () =>
      !this.demo &&
      membershipBlocks(this.membership()) &&
      (this.payment.payment() === 'own-key' || this.gateForced()),
  );

  /**
   * The ways to carry on without a membership while the own key is locked:
   * the open pool while it is on, and Tangent credit where it is sold (anyone
   * can buy it). Both false offers only the membership.
   */
  readonly keyLockedWays = computed(() => ({
    pool: !this.demo && this.payment.poolAvailable(),
    credit: !this.demo && this.payment.builtInCredit() && this.payment.creditUsable(),
  }));

  /** True when the learner's own OpenRouter key is stored in this browser. */
  readonly hasOwnKey = computed(
    () => this.keyStatus()?.providers.includes(LEARN_KEY_PROVIDER) ?? false,
  );

  /**
   * On the own-key choice without a key: replies can't run until one is
   * added. Not while the key is locked (`membershipBlocked`): the membership
   * is what's missing then, and asking for a key would mislead.
   */
  readonly needsKey = computed(
    () =>
      this.payment.payment() === 'own-key' &&
      this.keyStatus() !== null &&
      !this.hasOwnKey() &&
      !this.membershipBlocked(),
  );

  /** The available credit as money ("$1.20"); null until the billing summary is loaded. */
  readonly balanceText = computed(() => {
    const b = this.billing();
    return b ? formatMicros(b.availableMicros) : null;
  });

  /** The header's balance pill: only while replies run on credit. */
  readonly balanceLabel = computed(() =>
    this.payment.payment() === 'credit' ? this.balanceText() : null,
  );

  /** What replies run on (own key, credit or the pool), with its balance and whether it is used up. */
  readonly paidBy = computed<PaidBy>(() => {
    const payment = this.payment.payment();
    if (payment === 'credit') {
      const balance = this.balanceText();
      return {
        payment,
        label: 'Tangent credit',
        short: 'Credit',
        detail: balance === null ? null : `${balance} left`,
        warn: this.lowBalance(),
      };
    }
    if (payment === 'pool') {
      const status = this.poolStatus();
      return {
        payment,
        label: 'Open pool',
        short: 'Pool',
        detail: status?.enabled ? `${formatMicros(status.availableMicros)} in the pool` : null,
        warn: this.poolLow(),
      };
    }
    const missing = this.needsKey();
    const locked = this.membershipBlocked();
    return {
      payment,
      label: 'Your OpenRouter key',
      short: 'Your key',
      detail: locked ? 'needs a membership' : missing ? 'no key saved' : null,
      warn: missing || locked,
    };
  });

  /** The pool is empty, or the learner used up today's replies (the pill turns into a warning). */
  readonly poolLow = computed(() => {
    const status = this.poolStatus();
    const caps = this.poolMe()?.caps;
    return (
      (!!status && status.sessionsRemaining <= 0) ||
      (!!caps && caps.usedRequests >= caps.requestsPerDay)
    );
  });

  /** On the open pool, which uses one model: the Smart/Simple switch shows it, locked. */
  readonly poolModel = computed(() => {
    const status = this.poolStatus();
    return status?.enabled && this.payment.payment() === 'pool' ? status.model : null;
  });

  /** Why the Smart/Simple switch is locked, or null when it isn't. */
  readonly poolModelHint = computed(() => {
    const model = this.poolModel();
    return model ? `The open pool uses ${model.label}.` : null;
  });

  /**
   * The composer's funding toggle: both the learner's own credit (offered and
   * a balance left) and the pool can pay, so the learner picks. Hidden while
   * replies run on the own key: the toggle picks between the funded sources.
   * Membership plays no part: neither credit nor the pool needs one.
   */
  readonly fundingChoice = computed(() => {
    if (this.demo || !this.payment.builtInCredit() || !this.payment.poolAvailable()) return false;
    if (this.payment.payment() === 'own-key') return false;
    const own = this.poolMe()?.personalAvailableMicros ?? this.billing()?.availableMicros ?? 0;
    return own > 0;
  });

  /**
   * Personal credit can be bought now: credit is offered and the provider
   * sells top-ups. Anyone may buy, member or not.
   */
  readonly creditOnSale = computed(
    () => !this.demo && this.payment.builtInCredit() && this.billing()?.topUpsEnabled !== false,
  );

  /** True when the available credit is used up (the pill turns into a warning). */
  readonly lowBalance = computed(() => {
    const b = this.billing();
    return !!b && b.enabled && b.availableMicros <= 0;
  });

  /** Records the caller, their membership and whether this server sells credit. */
  setMe(me: MeResponse): void {
    this.me.set(me);
    this.useMembership(me.membership);
    this.payment.builtInCredit.set(me.builtInCredit);
  }

  /** A fresh billing summary (also from the billing page): balance and membership. */
  applyBilling(summary: BillingSummary): void {
    this.billing.set(summary);
    this.payment.creditAvailableMicros.set(summary.availableMicros);
    this.payment.topUpsEnabled.set(summary.topUpsEnabled !== false);
    this.useMembership(summary.membership);
  }

  /** A redeemed code (the billing page's code form) or any other new membership state. */
  setMembership(membership: MembershipInfo): void {
    this.useMembership(membership);
    this.billing.update((b) => (b ? { ...b, membership } : b));
  }

  /**
   * The server answered 402 `membership_required`: block now (the membership
   * may have lapsed since /api/me), then re-read the real state.
   */
  membershipRequired(): void {
    const current = this.membership();
    if (current) this.useMembership({ ...current, required: true, status: 'inactive' });
    this.gateForced.set(true);
    void this.refreshBalance();
  }

  /**
   * A way out of the locked own key (`keyLockedWays`): replies move to the
   * open pool or to Tangent credit, and the composer comes back (with a
   * message the server refused, `LessonStore.unsentDraft`).
   */
  continueOn(payment: 'pool' | 'credit'): void {
    this.gateForced.set(false);
    this.payment.choose(payment);
    if (payment === 'pool') void this.switchToPool();
    else void this.refreshBalance();
  }

  private useMembership(membership: MembershipInfo): void {
    this.membership.set(membership);
    this.payment.member.set(!membershipBlocks(membership));
  }

  /** Re-reads the balance and membership; failures keep the last known value. */
  async refreshBalance(): Promise<void> {
    try {
      this.applyBilling(await this.api.billing());
    } catch (err) {
      console.warn('Could not load the balance', err);
    }
  }

  /**
   * Re-reads the pool meter and, while the pool is on, the learner's caps;
   * the pool is offered as a way to pay only while it is on. Failures keep
   * the last known values.
   */
  async refreshPool(): Promise<void> {
    try {
      const status = await this.api.poolStatus();
      this.poolStatus.set(status);
      this.payment.poolAvailable.set(status.enabled);
      this.poolMe.set(status.enabled && !this.demo ? await this.api.poolMe() : null);
    } catch (err) {
      console.warn('Could not load the open pool', err);
    }
  }

  /**
   * The pool notice version the learner still has to acknowledge before
   * their first pool request, or null (none due, or the human check comes
   * first: the server asks for that before the notice).
   */
  readonly poolNoticeDue = computed(() => {
    const me = this.poolMe();
    if (!me?.available || !me.verified) return null;
    return (me.consentVersion ?? 0) < me.currentNoticeVersion ? me.currentNoticeVersion : null;
  });

  /**
   * The learner switched replies to the open pool: re-reads it and, if
   * they haven't acknowledged the current pool notice, shows it now (spec:
   * "when a user first switches to pool funding"). A pool send refused with
   * 403 `pool_consent_required` still opens it too.
   */
  async switchToPool(): Promise<void> {
    await this.refreshPool();
    const due = this.poolNoticeDue();
    if (due !== null && this.payment.payment() === 'pool') this.ui.poolConsentVersion.set(due);
  }

  async refreshKey(): Promise<void> {
    try {
      const status = await this.api.keyStatus();
      this.keyStatus.set(status);
      this.payment.hasOwnKey.set(status.providers.includes(LEARN_KEY_PROVIDER));
    } catch (err) {
      console.warn('Could not load the key status', err);
    }
  }

  /** Stores the learner's OpenRouter key (sealed into an HttpOnly cookie by the server). */
  async saveKey(apiKey: string): Promise<void> {
    await this.api.saveKey(LEARN_KEY_PROVIDER, apiKey);
    await this.refreshKey();
  }

  async forgetKey(): Promise<void> {
    await this.api.forgetKey(LEARN_KEY_PROVIDER);
    await this.refreshKey();
  }
}
