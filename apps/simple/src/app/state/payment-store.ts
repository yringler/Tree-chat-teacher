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
 * account. The own key needs the yearly membership where it is required
 * (`member`); credit and the pool never do. A choice the server doesn't
 * offer falls back: credit, then the own key if one is saved (or its status
 * isn't known yet) and the learner may use it, then the pool (only an
 * explicit pool choice outranks a saved key), then the own key. Credit
 * counts wherever it is sold and usable (`creditUsable`: anyone can buy it,
 * so an empty balance can be refilled). An explicit own-key choice stands
 * even without a membership: the shell then shows the membership gate
 * (`AccountStore.membershipBlocked`) instead of letting a send fail with a
 * 402. The server only honours `credit` and `pool` where it offers them
 * (`MeResponse.builtInCredit`, `PoolStatusResponse.enabled`), so a stale
 * choice can never spend anything the learner didn't pick.
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
   * AccountStore): replies on their own key are blocked then (402
   * `membership_required`). Credit and the pool don't care.
   */
  readonly member = signal(true);
  /** The learner's available credit (from the billing summary, via AccountStore); null until known. */
  readonly creditAvailableMicros = signal<number | null>(null);
  /**
   * False when the server sells no one-time top-ups (the billing summary's
   * `topUpsEnabled === false`, via AccountStore); true until known.
   */
  readonly topUpsEnabled = signal(true);
  /**
   * Credit can pay for replies: anyone can buy it (no membership needed), so
   * it is usable wherever top-ups are sold, and otherwise while a balance is
   * left. (Whether credit is sold at all is `builtInCredit`.)
   */
  readonly creditUsable = computed(
    () => this.topUpsEnabled() || (this.creditAvailableMicros() ?? 0) > 0,
  );
  /** The learner's explicit choice; null until they pick one (credit is the default where sold). */
  private readonly chosen = signal<LearnPayment | null>(stored());
  /** The demo always runs on its pretend credit, whatever this browser chose for real. */
  private readonly demo = inject(DEMO_MODE, { optional: true }) ?? false;

  /**
   * What replies actually run on: the own key when chosen (a non-member then
   * meets the membership gate); the pool when chosen and on; otherwise credit
   * if sold and usable (`creditUsable`), else a saved (or not yet known) own
   * key for a learner who may use it (so a key user who never picked never
   * lands on the pool, and a non-member never lands on their key unasked),
   * else the pool, else the own key.
   */
  readonly payment = computed<LearnPayment>(() => {
    if (this.demo) return 'credit';
    const chosen = this.chosen();
    const credit = this.builtInCredit() && this.creditUsable();
    const pool = this.poolAvailable();
    if (chosen === 'own-key') return 'own-key';
    if (chosen === 'pool' && pool) return 'pool';
    if (credit) return 'credit';
    if (this.member() && this.hasOwnKey() !== false) return 'own-key';
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
