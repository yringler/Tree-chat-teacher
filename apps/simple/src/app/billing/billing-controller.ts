import { computed, signal } from '@angular/core';
import type {
  BillingSummary,
  CheckoutResponse,
  UsageEntry,
  UsageListResponse,
} from '@tangent/shared';
import { MAX_TOP_UP_CENTS, MIN_TOP_UP_CENTS } from '@tangent/shared';
import { parseDollarsToCents, topUpError } from './format';

/** Paths Stripe sends the browser back to (relative to the origin; the base href is `/learn/`). */
export const BILLING_PATH = '/learn/billing';
export const CHECKOUT_SUCCESS_PATH = `${BILLING_PATH}?checkout=success`;
export const CHECKOUT_CANCEL_PATH = `${BILLING_PATH}?checkout=cancel`;

/** One-click top-up amounts, in cents. */
export const TOP_UP_PRESETS_CENTS: readonly number[] = [500, 1000, 2000, 5000];

/** After `?checkout=success`, poll `GET /api/billing` this often, this many times. */
export const POLL_INTERVAL_MS = 2000;
export const POLL_ATTEMPTS = 10;

export const USAGE_PAGE_SIZE = 25;

/**
 * What the page needs from the outside world. The component wires these to
 * `ApiClient`, `BillingClient`, `location.assign` and the router; tests pass
 * fakes. (Only types come from `@tangent/web-shared` so specs stay DOM-free.)
 */
export interface BillingDeps {
  api: {
    billing(): Promise<BillingSummary>;
    usage(cursor?: string | null, limit?: number): Promise<UsageListResponse>;
    createCheckout(amountCents: number): Promise<CheckoutResponse>;
  };
  /** The Better Auth Stripe plugin: `upgrade` subscribes to the membership, `portal` manages it. */
  billing: {
    upgrade(
      plan: string,
      successPath: string,
      cancelPath: string,
      returnPath?: string,
    ): Promise<void>;
    portal(returnPath: string): Promise<void>;
  };
  /** Leaves the app for a Stripe page (`location.assign`). */
  navigate(url: string): void;
  /** Drops `?checkout=...` from the address bar so a reload doesn't poll again. */
  clearCheckoutParam(): void;
  sleep?(ms: number): Promise<void>;
}

/**
 * - `waiting`: back from a paid checkout, polling until the webhook credits the account.
 * - `credited`: the balance changed.
 * - `slow`: polling gave up; the credit is probably still on its way.
 * - `cancelled`: back from an abandoned checkout.
 */
export type CheckoutNotice = 'waiting' | 'credited' | 'slow' | 'cancelled';

/** Which action is talking to Stripe (every action button is disabled meanwhile). */
export type PendingAction =
  { kind: 'top-up'; cents: number; source: 'preset' | 'custom' } | { kind: 'portal' };

/** State and actions of the billing page, framework-light so it can be unit tested. */
export class BillingController {
  readonly summary = signal<BillingSummary | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);

  readonly usage = signal<UsageEntry[]>([]);
  readonly usageCursor = signal<string | null>(null);
  readonly usageLoaded = signal(false);
  readonly usageLoading = signal(false);
  readonly usageError = signal<string | null>(null);

  readonly pending = signal<PendingAction | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly notice = signal<CheckoutNotice | null>(null);

  /** Raw text of the custom amount field; `customTouched` delays the error until a submit. */
  readonly customInput = signal('');
  readonly customTouched = signal(false);

  readonly minCents = computed(() => this.summary()?.minTopUpCents ?? MIN_TOP_UP_CENTS);
  readonly maxCents = computed(() => this.summary()?.maxTopUpCents ?? MAX_TOP_UP_CENTS);
  readonly presets = computed(() =>
    TOP_UP_PRESETS_CENTS.filter((c) => c >= this.minCents() && c <= this.maxCents()),
  );
  readonly customCents = computed(() => parseDollarsToCents(this.customInput()));
  readonly customError = computed(() =>
    topUpError(this.customCents(), this.minCents(), this.maxCents()),
  );
  readonly busy = computed(() => this.pending() !== null);

  private readonly sleep: (ms: number) => Promise<void>;
  private destroyed = false;
  private pollRun = 0;

  constructor(private readonly deps: BillingDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** First load; `checkout` is the `?checkout=` query parameter, if any. */
  async init(checkout: string | null | undefined): Promise<void> {
    if (checkout === 'cancel') {
      this.notice.set('cancelled');
      this.deps.clearCheckoutParam();
    }
    if (checkout === 'success') this.notice.set('waiting');
    await this.load();
    const summary = this.summary();
    if (summary?.enabled) void this.loadUsage(true);
    if (checkout === 'success') {
      if (summary) await this.waitForCredit(summary);
      else this.finishWaiting('slow');
    }
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      this.summary.set(await this.deps.api.billing());
    } catch (err) {
      this.loadError.set(messageOf(err));
    } finally {
      this.loading.set(false);
    }
  }

  /** `reset` reloads the first page; otherwise appends the page after `usageCursor`. */
  async loadUsage(reset = false): Promise<void> {
    if (this.usageLoading()) return;
    const cursor = reset ? null : this.usageCursor();
    if (!reset && cursor === null) return;
    this.usageLoading.set(true);
    this.usageError.set(null);
    try {
      const page = await this.deps.api.usage(cursor, USAGE_PAGE_SIZE);
      this.usage.update((list) => (reset ? page.entries : [...list, ...page.entries]));
      this.usageCursor.set(page.nextCursor);
      this.usageLoaded.set(true);
    } catch (err) {
      this.usageError.set(messageOf(err));
    } finally {
      this.usageLoading.set(false);
    }
  }

  /**
   * Webhooks credit the account asynchronously, so after a successful checkout
   * poll until the balance (or the membership) differs from `before`.
   */
  async waitForCredit(before: BillingSummary): Promise<void> {
    const run = ++this.pollRun;
    this.notice.set('waiting');
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      await this.sleep(POLL_INTERVAL_MS);
      if (this.destroyed || run !== this.pollRun) return;
      let next: BillingSummary;
      try {
        next = await this.deps.api.billing();
      } catch {
        continue; // a blip; keep trying until the attempts run out
      }
      if (this.destroyed || run !== this.pollRun) return;
      this.summary.set(next);
      if (changed(before, next)) {
        this.finishWaiting('credited');
        return;
      }
    }
    this.finishWaiting('slow');
  }

  dismissNotice(): void {
    this.pollRun++;
    this.notice.set(null);
  }

  async topUp(cents: number, source: 'preset' | 'custom' = 'preset'): Promise<void> {
    if (this.busy()) return;
    const error = topUpError(cents, this.minCents(), this.maxCents());
    if (error) {
      this.actionError.set(error);
      return;
    }
    await this.leaveFor({ kind: 'top-up', cents, source }, async () => {
      const { url } = await this.deps.api.createCheckout(cents);
      this.deps.navigate(url);
    });
  }

  async topUpCustom(): Promise<void> {
    this.customTouched.set(true);
    const cents = this.customCents();
    if (this.customError() || cents === null) return;
    await this.topUp(cents, 'custom');
  }

  setCustomInput(value: string): void {
    this.customInput.set(value);
    this.actionError.set(null);
  }

  async manage(): Promise<void> {
    if (this.busy()) return;
    await this.leaveFor(
      { kind: 'portal' },
      () => this.deps.billing.portal(BILLING_PATH),
      portalMessage,
    );
  }

  /** The browser came back to this page from its back/forward cache: buttons work again. */
  resetPending(): void {
    this.pending.set(null);
  }

  destroy(): void {
    this.destroyed = true;
  }

  /**
   * Runs a step that ends in a navigation to Stripe. On success the page is
   * unloading, so `pending` stays set (no double clicks while it goes).
   */
  private async leaveFor(
    action: PendingAction,
    step: () => Promise<void>,
    describe: (err: unknown) => string = messageOf,
  ): Promise<void> {
    this.pending.set(action);
    this.actionError.set(null);
    try {
      await step();
    } catch (err) {
      this.actionError.set(describe(err));
      this.pending.set(null);
    }
  }

  private finishWaiting(result: 'credited' | 'slow'): void {
    this.notice.set(result);
    this.deps.clearCheckoutParam();
  }
}

function changed(before: BillingSummary, after: BillingSummary): boolean {
  return (
    before.balanceMicros !== after.balanceMicros ||
    before.membership.status !== after.membership.status
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A `BillingError` from the portal; no Stripe customer yet is the common, harmless case. */
function portalMessage(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : null;
  if (code === 'CUSTOMER_NOT_FOUND' || code === 'SUBSCRIPTION_NOT_FOUND')
    return 'There is nothing to manage yet: payment methods and invoices appear here after your first purchase.';
  return messageOf(err);
}
