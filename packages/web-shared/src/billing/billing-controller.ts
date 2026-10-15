import { computed, signal } from '@angular/core';
import type {
  BillingSummary,
  CheckoutResponse,
  MembershipInfo,
  UsageEntry,
  UsageListResponse,
} from '@tangent/shared';
import { MAX_TOP_UP_CENTS, MIN_TOP_UP_CENTS, serviceFeeCents } from '@tangent/shared';
import type { PortalTab } from '../core/billing-client';
import { parseDollarsToCents, topUpError } from './format';
import { type MembershipUpgrader, subscribeToMembership } from './membership';

/** The top-up amounts offered as buttons, in cents of credit. */
export const TOP_UP_PRESETS_CENTS: readonly number[] = [500, 1000, 2000, 5000];

/** After `?checkout=success`, poll `GET /api/billing` this often, this many times. */
export const POLL_INTERVAL_MS = 2000;
export const POLL_ATTEMPTS = 10;

export const USAGE_PAGE_SIZE = 25;

/**
 * What the page needs from the outside world. The component wires these to
 * `ApiClient`, `BillingClient`, `location.assign` and the router; tests pass
 * fakes, so specs stay DOM-free.
 */
export interface BillingDeps {
  api: {
    billing(): Promise<BillingSummary>;
    usage(cursor?: string | null, limit?: number): Promise<UsageListResponse>;
    createCheckout(amountCents: number): Promise<CheckoutResponse>;
  };
  /** `BillingClient`: `upgrade` subscribes to the membership, `portal` manages it in a tab. */
  billing: MembershipUpgrader & {
    portal(tab: PortalTab): Promise<void>;
  };
  /** Opens the tab the portal shows in (`openPortalTab`); called during the click that asks for it. */
  openTab(): PortalTab;
  /** Leaves the app for the payment provider's checkout (`location.assign`). */
  navigate(url: string): void;
  /** Drops `?checkout=...` from the address bar so a reload doesn't poll again. */
  clearCheckoutParam(): void;
  sleep?(ms: number): Promise<void>;
}

/**
 * - `waiting`: back from a paid checkout, polling until the webhook updates the account.
 * - `activated`: the membership status changed (it is active now).
 * - `credited`: the balance changed.
 * - `slow`: polling gave up; the credit is probably still on its way.
 * - `cancelled`: back from an abandoned checkout.
 */
export type CheckoutNotice = 'waiting' | 'activated' | 'credited' | 'slow' | 'cancelled';

/** A top-up before checkout: the credit chosen, the service fee on it, and their sum before tax. */
export interface TopUpBreakdown {
  creditCents: number;
  feeCents: number;
  subtotalCents: number;
}

/** Which action is talking to the payment provider (every action button is disabled meanwhile). */
export type PendingAction =
  { kind: 'top-up'; cents: number } | { kind: 'subscribe' } | { kind: 'portal' };

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

  /** The preset amount picked, if any; typing an amount of their own clears it. */
  readonly selectedPreset = signal<number | null>(null);
  /** Raw text of the custom amount field; `customTouched` delays the error until a blur or submit. */
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
  /** The credit to buy: the preset picked, else a valid typed amount; null = nothing to buy yet. */
  readonly selectedCents = computed(
    () => this.selectedPreset() ?? (this.customError() === null ? this.customCents() : null),
  );
  /** What the chosen credit costs before tax, once the summary (with its service fee) is loaded. */
  readonly breakdown = computed((): TopUpBreakdown | null => {
    const creditCents = this.selectedCents();
    const fee = this.summary()?.serviceFee;
    if (creditCents === null || !fee) return null;
    const feeCents = serviceFeeCents(creditCents, fee);
    return { creditCents, feeCents, subtotalCents: creditCents + feeCents };
  });

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
      const change = changeOf(before, next);
      if (change) {
        this.finishWaiting(change);
        return;
      }
    }
    this.finishWaiting('slow');
  }

  dismissNotice(): void {
    this.pollRun++;
    this.notice.set(null);
  }

  selectPreset(cents: number): void {
    this.selectedPreset.set(cents);
    this.customInput.set('');
    this.customTouched.set(false);
    this.actionError.set(null);
  }

  setCustomInput(value: string): void {
    this.selectedPreset.set(null);
    this.customInput.set(value);
    this.actionError.set(null);
  }

  /** Add credit: the secure checkout for the amount chosen, back to this page. */
  async addCredit(): Promise<void> {
    if (this.busy()) return;
    const cents = this.selectedCents();
    if (cents === null) {
      this.customTouched.set(true);
      return;
    }
    await this.leaveFor({ kind: 'top-up', cents }, async () => {
      const { url } = await this.deps.api.createCheckout(cents);
      this.deps.navigate(url);
    });
  }

  /** Subscribe: the secure checkout for the yearly membership, back to this page. */
  async subscribe(): Promise<void> {
    if (this.busy()) return;
    await this.leaveFor({ kind: 'subscribe' }, () => subscribeToMembership(this.deps.billing));
  }

  /**
   * Manage billing: the portal opens in a new tab, so this page stays. The tab is
   * opened here, synchronously, so the click still allows it.
   */
  async manage(): Promise<void> {
    if (this.busy()) return;
    const tab = this.deps.openTab();
    this.pending.set({ kind: 'portal' });
    this.actionError.set(null);
    try {
      await this.deps.billing.portal(tab);
    } catch (err) {
      this.actionError.set(portalMessage(err));
    } finally {
      this.pending.set(null);
    }
  }

  /** A redeemed code changed the membership (no reload needed). */
  setMembership(membership: MembershipInfo): void {
    this.summary.update((s) => (s ? { ...s, membership } : s));
  }

  /** The browser came back to this page from its back/forward cache: buttons work again. */
  resetPending(): void {
    this.pending.set(null);
  }

  destroy(): void {
    this.destroyed = true;
  }

  /**
   * Runs a step that ends in a navigation to the payment provider. On success the page is
   * unloading, so `pending` stays set (no double clicks while it goes).
   */
  private async leaveFor(action: PendingAction, step: () => Promise<void>): Promise<void> {
    this.pending.set(action);
    this.actionError.set(null);
    try {
      await step();
    } catch (err) {
      this.actionError.set(messageOf(err));
      this.pending.set(null);
    }
  }

  private finishWaiting(result: 'activated' | 'credited' | 'slow'): void {
    this.notice.set(result);
    this.deps.clearCheckoutParam();
  }
}

/** What a webhook changed since `before`; a membership change wins over a balance change. */
function changeOf(before: BillingSummary, after: BillingSummary): 'activated' | 'credited' | null {
  if (before.membership.status !== after.membership.status) return 'activated';
  if (before.balanceMicros !== after.balanceMicros) return 'credited';
  return null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A `BillingError` from the portal; no customer yet (`no_customer`) is the common, harmless case. */
function portalMessage(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : null;
  if (code === 'no_customer')
    return 'There is nothing to manage yet: payment methods and invoices appear here after your first purchase.';
  return messageOf(err);
}
