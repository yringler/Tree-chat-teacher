import { computed, inject, Injectable, signal } from '@angular/core';
import {
  LEARN_KEY_PROVIDER,
  type BillingSummary,
  type KeyStatusResponse,
  type MeResponse,
} from '@tangent/shared';
import { ApiClient } from '@tangent/web-shared';
import { formatMicros } from '../billing/format';
import { PaymentStore } from './payment-store';

/** The signed-in caller, how they pay (own key or credit) and their credit balance. */
@Injectable({ providedIn: 'root' })
export class AccountStore {
  private readonly api = inject(ApiClient);
  readonly payment = inject(PaymentStore);

  readonly me = signal<MeResponse | null>(null);
  /** Null until loaded, or when billing can't be read (the pill is hidden then). */
  readonly billing = signal<BillingSummary | null>(null);
  /** The key cookie's state; null until loaded (and in the demo, which has no keys). */
  readonly keyStatus = signal<KeyStatusResponse | null>(null);

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

  /** Records the caller and whether this server sells credit. */
  setMe(me: MeResponse): void {
    this.me.set(me);
    this.payment.paidCredit.set(me.paidCredit);
  }

  /** Re-reads the balance; failures keep the last known value (it's informational). */
  async refreshBalance(): Promise<void> {
    try {
      this.billing.set(await this.api.billing());
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
