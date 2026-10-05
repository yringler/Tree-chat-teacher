import { computed, inject, Injectable, signal } from '@angular/core';
import {
  LEARN_KEY_PROVIDER,
  type BillingSummary,
  type KeyStatusResponse,
  type MembershipInfo,
  type MeResponse,
  type PoolMeResponse,
  type PoolStatusResponse,
} from '@tangent/shared';
import { ApiClient, DEMO_MODE, formatMicros, membershipBlocks } from '@tangent/web-shared';
import { PaymentStore } from './payment-store';
import { UiStore } from './ui-store';

/**
 * The signed-in caller, their membership, how they pay (own key, credit or
 * the community pool), their credit balance and the pool's meter.
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
  /** The community pool's meter; null until loaded or when it can't be read. */
  readonly poolStatus = signal<PoolStatusResponse | null>(null);
  /** The learner's caps and use of the pool today; null until loaded, or while the pool is off. */
  readonly poolMe = signal<PoolMeResponse | null>(null);
  private readonly demo = inject(DEMO_MODE, { optional: true }) ?? false;

  /** The server refused a reply for want of a membership (402), so the gate shows even beside the pool. */
  private readonly gateForced = signal(false);

  /**
   * Generating needs a membership the learner doesn't have: the shell shows
   * the gate. With the pool on, a non-member is on the free tier instead, and
   * sees the gate only after a members-only reply (own key) was refused.
   */
  readonly membershipBlocked = computed(
    () =>
      membershipBlocks(this.membership()) && (this.gateForced() || !this.payment.poolAvailable()),
  );

  /** The gate may offer the free tier instead of subscribing: the pool is on. */
  readonly freeTierOffered = computed(() => !this.demo && this.payment.poolAvailable());

  /** True when the learner's own OpenRouter key is stored in this browser. */
  readonly hasOwnKey = computed(
    () => this.keyStatus()?.providers.includes(LEARN_KEY_PROVIDER) ?? false,
  );

  /** On the own-key choice without a key: replies can't run until one is added. */
  readonly needsKey = computed(
    () => this.payment.payment() === 'own-key' && this.keyStatus() !== null && !this.hasOwnKey(),
  );

  /** The header's balance pill: only while replies run on credit. */
  readonly balanceLabel = computed(() => {
    const b = this.billing();
    return b && this.payment.payment() === 'credit' ? formatMicros(b.availableMicros) : null;
  });

  /** The header's pool pill while replies run on the pool: the dollars in it. */
  readonly poolLabel = computed(() => {
    const status = this.poolStatus();
    return status?.enabled && this.payment.payment() === 'pool'
      ? `Pool · ${formatMicros(status.availableMicros)}`
      : null;
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

  /** On the community pool, which uses one model: the Smart/Simple switch shows it, locked. */
  readonly poolModel = computed(() => {
    const status = this.poolStatus();
    return status?.enabled && this.payment.payment() === 'pool' ? status.model : null;
  });

  /** Why the Smart/Simple switch is locked, or null when it isn't. */
  readonly poolModelHint = computed(() => {
    const model = this.poolModel();
    return model ? `The community pool uses ${model.label}.` : null;
  });

  /**
   * The composer's funding toggle: both the learner's own credit (offered and
   * not used up) and the pool can pay, so the learner picks. Hidden while
   * replies run on the own key: the toggle picks between the funded sources.
   */
  readonly fundingChoice = computed(() => {
    if (this.demo || !this.payment.builtInCredit() || !this.payment.poolAvailable()) return false;
    if (this.payment.payment() === 'own-key') return false;
    const own = this.poolMe()?.personalAvailableMicros ?? this.billing()?.availableMicros ?? 0;
    return own > 0;
  });

  /** Personal credit can be bought now: credit is offered and the provider sells top-ups. */
  readonly creditOnSale = computed(
    () => !this.demo && this.payment.builtInCredit() && this.billing()?.topUpsEnabled !== false,
  );

  /** The membership is sold here and the learner has none: the pool notice offers it. */
  readonly membershipOnSale = computed(() => !this.demo && membershipBlocks(this.membership()));

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
    this.useMembership(summary.membership);
  }

  /** A redeemed code (the gate's `redeemed`) or any other new membership state. */
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

  /** The gate's "use the community pool": replies move to the pool's free tier. */
  useFreeTier(): void {
    this.gateForced.set(false);
    this.payment.choose('pool');
    void this.switchToPool();
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
      console.warn('Could not load the community pool', err);
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
   * The learner switched replies to the community pool: re-reads it and, if
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
