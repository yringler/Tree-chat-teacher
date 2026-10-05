import { computed, signal } from '@angular/core';
import {
  POOL_FUND_PRESETS_CENTS,
  type CheckoutResponse,
  type PoolStatusResponse,
  type PurchaseTarget,
} from '@tangent/shared';

/** After a paid pool checkout, poll `GET /api/pool/status` this often, this many times. */
export const POOL_POLL_INTERVAL_MS = 5000;
export const POOL_POLL_ATTEMPTS = 14;

/** What the fund section needs from the outside world (fakes in the specs). */
export interface PoolFundDeps {
  api: {
    poolStatus(): Promise<PoolStatusResponse>;
    createCheckout(amountCents: number, target: PurchaseTarget): Promise<CheckoutResponse>;
  };
  /** Leaves the app for the payment provider's checkout (`location.assign`). */
  navigate(url: string): void;
  sleep?(ms: number): Promise<void>;
}

/**
 * - `waiting`: back from a paid pool checkout, until the pool's balance rises;
 * - `pool-funded`: it rose (thanks!);
 * - `slow`: polling gave up; the credit is probably still on its way.
 */
export type PoolFundNotice = 'waiting' | 'pool-funded' | 'slow';

/**
 * State and actions of the fund-the-pool section, framework-light (signals
 * only) so it is unit tested without a DOM. A pool purchase is a credit
 * purchase with the pool as its target, from the presets
 * (`POOL_FUND_PRESETS_CENTS`) at or above the pool minimum.
 */
export class PoolFundController {
  readonly status = signal<PoolStatusResponse | null>(null);
  readonly loadError = signal<string | null>(null);
  /** The preset whose checkout is opening (every button is disabled meanwhile). */
  readonly pending = signal<number | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly notice = signal<PoolFundNotice | null>(null);

  readonly presets = computed(() => {
    const min = this.status()?.minPurchaseCents ?? 0;
    return POOL_FUND_PRESETS_CENTS.filter((c) => c >= min);
  });
  readonly busy = computed(() => this.pending() !== null);

  private readonly sleep: (ms: number) => Promise<void>;
  private destroyed = false;
  private pollRun = 0;

  constructor(private readonly deps: PoolFundDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** First load; `funded` = back from a paid pool checkout (`?checkout=success&target=pool`). */
  async init(funded: boolean): Promise<void> {
    if (funded) this.notice.set('waiting');
    await this.load();
    const before = this.status();
    if (funded) {
      if (before) await this.waitForFunds(before);
      else this.notice.set('slow');
    }
  }

  async load(): Promise<void> {
    this.loadError.set(null);
    try {
      this.status.set(await this.deps.api.poolStatus());
    } catch (err) {
      this.loadError.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * The webhook credits the pool asynchronously and the meter is cached for
   * a minute, so poll until the pool's available balance rises above
   * `before`. Only a rise counts: other learners' replies hold and settle
   * against the pool all the time, so a mere change says nothing about the
   * purchase.
   */
  async waitForFunds(before: PoolStatusResponse): Promise<void> {
    const run = ++this.pollRun;
    this.notice.set('waiting');
    for (let attempt = 0; attempt < POOL_POLL_ATTEMPTS; attempt++) {
      await this.sleep(POOL_POLL_INTERVAL_MS);
      if (this.destroyed || run !== this.pollRun) return;
      let next: PoolStatusResponse;
      try {
        next = await this.deps.api.poolStatus();
      } catch {
        continue;
      }
      if (this.destroyed || run !== this.pollRun) return;
      this.status.set(next);
      if (next.availableMicros > before.availableMicros) {
        this.notice.set('pool-funded');
        return;
      }
    }
    this.notice.set('slow');
  }

  /** Opens the secure checkout for `cents` of pool credit. */
  async fund(cents: number): Promise<void> {
    const status = this.status();
    if (this.busy() || !status?.enabled || !status.fundingOpen) return;
    if (cents < status.minPurchaseCents) {
      this.actionError.set('That amount is below the pool minimum.');
      return;
    }
    this.pending.set(cents);
    this.actionError.set(null);
    try {
      const { url } = await this.deps.api.createCheckout(cents, 'pool');
      // The page is unloading: `pending` stays set, so nothing is clicked twice.
      this.deps.navigate(url);
    } catch (err) {
      this.actionError.set(err instanceof Error ? err.message : String(err));
      this.pending.set(null);
    }
  }

  dismissNotice(): void {
    this.pollRun++;
    this.notice.set(null);
  }

  /** Back from the checkout through the back/forward cache: the buttons work again. */
  resetPending(): void {
    this.pending.set(null);
  }

  destroy(): void {
    this.destroyed = true;
  }
}
