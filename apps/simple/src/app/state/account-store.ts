import { computed, inject, Injectable, signal } from '@angular/core';
import {
  LEARN_KEY_PROVIDER,
  type BillingSummary,
  type KeyStatusResponse,
  type MembershipInfo,
  type MeResponse,
} from '@tangent/shared';
import { ApiClient, formatMicros, membershipBlocks } from '@tangent/web-shared';
import { PaymentStore } from './payment-store';

/**
 * The signed-in caller, their membership, how they pay (own key or credit)
 * and their credit balance.
 */
@Injectable({ providedIn: 'root' })
export class AccountStore {
  private readonly api = inject(ApiClient);
  readonly payment = inject(PaymentStore);

  readonly me = signal<MeResponse | null>(null);
  /** Null until loaded, or when billing can't be read (the pill is hidden then). */
  readonly billing = signal<BillingSummary | null>(null);
  /** From /api/me, then from every billing summary and redeemed code; null until loaded. */
  readonly membership = signal<MembershipInfo | null>(null);
  /** The key cookie's state; null until loaded (and in the demo, which has no keys). */
  readonly keyStatus = signal<KeyStatusResponse | null>(null);

  /** Generating needs a membership the learner doesn't have: the shell shows the gate. */
  readonly membershipBlocked = computed(() => membershipBlocks(this.membership()));

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

  /** True when the available credit is used up (the pill turns into a warning). */
  readonly lowBalance = computed(() => {
    const b = this.billing();
    return !!b && b.enabled && b.availableMicros <= 0;
  });

  /** Records the caller, their membership and whether this server sells credit. */
  setMe(me: MeResponse): void {
    this.me.set(me);
    this.membership.set(me.membership);
    this.payment.builtInCredit.set(me.builtInCredit);
  }

  /** A fresh billing summary (also from the billing page): balance and membership. */
  applyBilling(summary: BillingSummary): void {
    this.billing.set(summary);
    this.membership.set(summary.membership);
  }

  /** A redeemed code (the gate's `redeemed`) or any other new membership state. */
  setMembership(membership: MembershipInfo): void {
    this.membership.set(membership);
    this.billing.update((b) => (b ? { ...b, membership } : b));
  }

  /**
   * The server answered 402 `membership_required`: block now (the membership
   * may have lapsed since /api/me), then re-read the real state.
   */
  membershipRequired(): void {
    const current = this.membership();
    if (current) this.membership.set({ ...current, required: true, status: 'inactive' });
    void this.refreshBalance();
  }

  /** Re-reads the balance and membership; failures keep the last known value. */
  async refreshBalance(): Promise<void> {
    try {
      this.applyBilling(await this.api.billing());
    } catch (err) {
      console.warn('Could not load the balance', err);
    }
  }

  async refreshKey(): Promise<void> {
    try {
      this.keyStatus.set(await this.api.keyStatus());
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
