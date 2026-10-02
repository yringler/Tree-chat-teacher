import { computed, inject, Injectable, signal } from '@angular/core';
import { MODE_HEADER, PAYMENT_HEADER, type LearnPayment } from '@tangent/shared';
import { DEMO_MODE } from '../demo/demo-mode';

const STORAGE_KEY = 'tangent.learn.payment';

function stored(): LearnPayment | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'own-key' || v === 'credit' ? v : null;
  } catch {
    return null;
  }
}

/**
 * How Learn pays for replies: the learner's own OpenRouter key, or prepaid
 * credit. The choice is remembered in this browser and sent with every API
 * call (API_HEADERS, see app.config.ts), together with the mode header that
 * makes the server act as the learner's Learn account. The server only
 * honours `credit` where it offers it (`MeResponse.paidCredit`), so a stale
 * choice can never spend anything the learner didn't pick.
 *
 * Kept free of ApiClient: ApiClient reads `headers()`, so injecting it here
 * would be circular.
 */
@Injectable({ providedIn: 'root' })
export class PaymentStore {
  /** True when this server sells credit (from /api/me). */
  readonly paidCredit = signal(false);
  private readonly chosen = signal<LearnPayment>(stored() ?? 'credit');
  /** The demo always runs on its pretend credit, whatever this browser chose for real. */
  private readonly demo = inject(DEMO_MODE, { optional: true }) ?? false;

  /** What replies actually run on: the choice, or the own key when credit isn't offered. */
  readonly payment = computed<LearnPayment>(() => {
    if (this.demo) return 'credit';
    return this.paidCredit() ? this.chosen() : 'own-key';
  });

  choose(payment: LearnPayment): void {
    this.chosen.set(payment);
    try {
      localStorage.setItem(STORAGE_KEY, payment);
    } catch {
      // Storage unavailable: the choice lasts for this page.
    }
  }

  /** Headers for every API call of the Learn app. */
  headers(): Record<string, string> {
    return { [MODE_HEADER]: 'simple', [PAYMENT_HEADER]: this.payment() };
  }
}
