import { computed, inject, Injectable, signal } from '@angular/core';
import type { BillingSummary, MeResponse } from '@tangent/shared';
import { ApiClient } from '@tangent/web-shared';
import { formatMicros } from '../billing/format';

/** The signed-in caller and their credit balance (the header's balance pill). */
@Injectable({ providedIn: 'root' })
export class AccountStore {
  private readonly api = inject(ApiClient);

  readonly me = signal<MeResponse | null>(null);
  /** Null until loaded, or when billing can't be read (the pill is hidden then). */
  readonly billing = signal<BillingSummary | null>(null);

  readonly balanceLabel = computed(() => {
    const b = this.billing();
    return b ? formatMicros(b.availableMicros) : null;
  });

  /** True when the available credit is used up (the pill turns into a warning). */
  readonly lowBalance = computed(() => {
    const b = this.billing();
    return !!b && b.enabled && b.availableMicros <= 0;
  });

  /** Re-reads the balance; failures keep the last known value (it's informational). */
  async refreshBalance(): Promise<void> {
    try {
      this.billing.set(await this.api.billing());
    } catch (err) {
      console.warn('Could not load the balance', err);
    }
  }
}
