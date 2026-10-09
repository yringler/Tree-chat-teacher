import { Injectable, signal } from '@angular/core';
import { MODE_HEADER, PAYERS, PAYMENT_HEADER, type Payer } from '@tangent/shared';

const STORAGE_KEY = 'tangent.learn.payment';

function stored(): Payer | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return PAYERS.find((p) => p === v) ?? null;
  } catch {
    return null;
  }
}

/**
 * The learner's pick of who pays (remembered in this browser) and the payer
 * every API call names (API_HEADERS, see app.config.ts), with the mode
 * header that makes the server act as the learner's Learn account.
 * LearnFunding resolves the payer from the pick and what it knows
 * (`resolveWith`); it calls the API, which reads these headers, so this
 * holder is what keeps the two apart.
 */
@Injectable({ providedIn: 'root' })
export class PaymentChoice {
  /** The learner's own pick; null until they make one. */
  readonly chosen = signal<Payer | null>(stored());
  private payer: () => Payer = () => this.chosen() ?? 'own-key';

  /** The payer the calls name from now on. */
  resolveWith(payer: () => Payer): void {
    this.payer = payer;
  }

  choose(payer: Payer): void {
    this.chosen.set(payer);
    try {
      localStorage.setItem(STORAGE_KEY, payer);
    } catch {
      // Storage unavailable: the choice lasts for this page.
    }
  }

  /** Headers for every API call of the Learn app. */
  headers(): Record<string, string> {
    return { [MODE_HEADER]: 'simple', [PAYMENT_HEADER]: this.payer() };
  }
}
