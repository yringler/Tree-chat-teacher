import { computed, inject, Injectable, signal } from '@angular/core';
import { MODE_HEADER, PAYMENT_HEADER, type LearnPayment } from '@tangent/shared';
import { DEMO_MODE } from '@tangent/web-shared';

const STORAGE_KEY = 'tangent.learn.payment';

function stored(): LearnPayment | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'own-key' || v === 'credit' || v === 'pool' ? v : null;
  } catch {
    return null;
  }
}

/**
 * How Learn pays for replies: the learner's own OpenRouter key, prepaid
 * credit, or the open pool. The choice is remembered in this browser
 * and sent with every API call (API_HEADERS, see app.config.ts), together
 * with the mode header that makes the server act as the learner's Learn
 * account. A choice the server doesn't offer falls back: credit, then the
 * own key if one is saved, then the pool (only an explicit pool choice
 * outranks a saved key), then the own key. Credit counts only while it is
 * usable (`creditUsable`): for a member, or for anyone with a balance left
 * (spending credit needs no membership; buying it does). The server only honours `credit` and `pool` where
 * it offers them (`MeResponse.builtInCredit`, `PoolStatusResponse.enabled`),
 * so a stale choice can never spend anything the learner didn't pick.
 *
 * Kept free of ApiClient: ApiClient reads `headers()`, so injecting it here
 * would be circular.
 */
@Injectable({ providedIn: 'root' })
export class PaymentStore {
  /** True when this server sells credit (from /api/me). */
  readonly builtInCredit = signal(false);
  /** True when the open pool is on (from /api/pool/status). */
  readonly poolAvailable = signal(false);
  /**
   * Whether the learner's own OpenRouter key is saved (from /api/keys, via
   * AccountStore); null until that call succeeds, so a key status that is
   * still loading, or failed, never moves a key user onto the pool.
   */
  readonly hasOwnKey = signal<boolean | null>(null);
  /**
   * False when the membership is required and the learner has none (from
   * AccountStore): they can't buy credit then, only spend what they hold.
   */
  readonly member = signal(true);
  /** The learner's available credit (from the billing summary, via AccountStore); null until known. */
  readonly creditAvailableMicros = signal<number | null>(null);
  /**
   * Credit can pay for replies: the learner is a member (or none is
   * required), who can always buy more, or has a balance left to spend.
   */
  readonly creditUsable = computed(() => this.member() || (this.creditAvailableMicros() ?? 0) > 0);
  /** The learner's explicit choice; null until they pick one (credit is the default where sold). */
  private readonly chosen = signal<LearnPayment | null>(stored());
  /** The demo always runs on its pretend credit, whatever this browser chose for real. */
  private readonly demo = inject(DEMO_MODE, { optional: true }) ?? false;

  /**
   * What replies actually run on: the own key when chosen; the pool when
   * chosen and on; otherwise credit if sold and usable (`creditUsable`),
   * else a saved (or not yet known) own key (so a key
   * user who never picked never lands on the pool), else the pool, else the
   * own key.
   */
  readonly payment = computed<LearnPayment>(() => {
    if (this.demo) return 'credit';
    const chosen = this.chosen();
    const credit = this.builtInCredit() && this.creditUsable();
    const pool = this.poolAvailable();
    if (chosen === 'own-key') return 'own-key';
    if (chosen === 'pool' && pool) return 'pool';
    if (credit) return 'credit';
    if (this.hasOwnKey() !== false) return 'own-key';
    return pool ? 'pool' : 'own-key';
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
