import { signal } from '@angular/core';
import { MEMBERSHIP_PLAN, type MembershipInfo } from '@tangent/shared';
import { ApiError } from '../core/api-client';
import { formatBps, formatCents } from './format';

/*
 * The yearly membership as both apps show it: the gate, the billing page's
 * Membership section and the code form. Framework-light (signals only) so
 * the specs run without a DOM.
 */

/** True when generating is blocked until the user subscribes or redeems a code. */
export function membershipBlocks(m: MembershipInfo | null | undefined): boolean {
  return !!m && m.required && m.status === 'inactive';
}

/** Where Stripe Checkout and the portal send the browser back (`billingPath` is absolute, e.g. `/learn/billing`). */
export function membershipCheckoutPaths(billingPath: string): {
  success: string;
  cancel: string;
  returnTo: string;
} {
  return {
    success: `${billingPath}?checkout=success`,
    cancel: `${billingPath}?checkout=cancel`,
    returnTo: billingPath,
  };
}

/** The part of `BillingClient` that subscribes (the Better Auth Stripe plugin). */
export interface MembershipUpgrader {
  upgrade(
    plan: string,
    successPath: string,
    cancelPath: string,
    returnPath?: string,
  ): Promise<void>;
}

/** Opens Stripe Checkout for the membership; resolves only if the browser is not leaving. */
export function subscribeToMembership(
  billing: MembershipUpgrader,
  billingPath: string,
): Promise<void> {
  const p = membershipCheckoutPaths(billingPath);
  return billing.upgrade(MEMBERSHIP_PLAN, p.success, p.cancel, p.returnTo);
}

/** `$10 / year plus tax` (prices are pre-tax; Stripe Tax adds it at checkout). */
export function membershipPriceText(m: Pick<MembershipInfo, 'priceCents'>): string {
  return `${formatCents(m.priceCents)} / year plus tax`;
}

/** The yearly credit gift, or null when the server promises none. */
export function includedCreditText(m: Pick<MembershipInfo, 'includedCreditCents'>): string | null {
  return m.includedCreditCents > 0
    ? `Includes ${formatCents(m.includedCreditCents)} of credit each year.`
    : null;
}

/** `2027-10-02T…` → `Oct 2, 2027`; null when missing or unreadable. */
export function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** One line on where the user stands (the billing page's Membership section). */
export function membershipStatusText(m: MembershipInfo): string {
  if (m.status === 'waived') return 'Waived: the membership is free for you.';
  if (m.status === 'inactive')
    return 'Not active. Subscribe to get new replies; your conversations stay readable either way.';
  const until = formatDay(m.periodEnd);
  if (m.cancelAtPeriodEnd)
    return until ? `Active until ${until}. It won't renew.` : "Active. It won't renew.";
  if (m.subscriptionStatus === 'past_due')
    return 'Active, but the last payment failed. Update your card in Manage billing.';
  return until ? `Active until ${until}, then renews each year.` : 'Active.';
}

/**
 * What one call on credit costs, as a phrase:
 * `the model's OpenRouter price + 5.5% OpenRouter fee + 10%`.
 * (charge = price × (1 + fee) × (1 + markup); a zero part is left out.)
 */
export function creditFeeText(markupBps: number, openRouterFeeBps: number): string {
  let text = "the model's OpenRouter price";
  if (openRouterFeeBps > 0) text += ` + ${formatBps(openRouterFeeBps)} OpenRouter fee`;
  if (markupBps > 0) text += ` + ${formatBps(markupBps)}`;
  return text;
}

/** A failed code redemption, in words fit for the form. */
export function waiverErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "That code didn't work. Check it and try again.";
    if (err.status === 429) return 'Too many tries. Wait a minute, then try again.';
    if (err.status === 400) return "This server doesn't take membership codes.";
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** State of the "Have a code?" form. */
export class WaiverForm {
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  constructor(
    private readonly redeem: (code: string) => Promise<MembershipInfo>,
    private readonly onRedeemed: (membership: MembershipInfo) => void,
  ) {}

  /** Redeems `raw`; true when the code worked (`onRedeemed` has been called). */
  async submit(raw: string): Promise<boolean> {
    if (this.busy()) return false;
    const code = raw.trim();
    if (!code) {
      this.error.set('Enter your code.');
      return false;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      this.onRedeemed(await this.redeem(code));
      return true;
    } catch (err) {
      this.error.set(waiverErrorMessage(err));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  clearError(): void {
    this.error.set(null);
  }
}

/** The gate's Subscribe button: opens Stripe Checkout, or says why it couldn't. */
export class MembershipSubscribe {
  /** Stays true on success: the page is leaving for Stripe (no double clicks meanwhile). */
  readonly pending = signal(false);
  readonly error = signal<string | null>(null);

  constructor(
    private readonly billing: MembershipUpgrader,
    private readonly billingPath: () => string,
  ) {}

  async subscribe(): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    this.error.set(null);
    try {
      await subscribeToMembership(this.billing, this.billingPath());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      this.pending.set(false);
    }
  }

  /** Back from Stripe through the back/forward cache: the button works again. */
  reset(): void {
    this.pending.set(false);
  }
}
