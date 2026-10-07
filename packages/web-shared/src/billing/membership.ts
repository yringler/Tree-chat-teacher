import { signal } from '@angular/core';
import type { BillingSummary, MembershipInfo } from '@tangent/shared';
import { ApiError } from '../core/api-client';
import { formatBps, formatCents } from './format';

/*
 * The yearly membership as the apps show it: the locked-key notices, the billing page's
 * Membership section and the code form. Framework-light (signals only) so
 * the specs run without a DOM.
 */

/**
 * True when the membership is required and the user has none: generating on
 * their own API keys (Learn, power mode, Canvas) is blocked until they
 * subscribe or redeem a code. Tangent credit (buying and spending) and the
 * open pool never are.
 */
export function membershipBlocks(m: MembershipInfo | null | undefined): boolean {
  return !!m && m.required && m.status === 'inactive';
}

/**
 * Without a membership, generating can still run on Tangent credit, which
 * anyone can buy: true while credit is offered (`builtInCredit`) and either
 * top-ups are sold (an empty balance can be refilled) or the balance isn't
 * known to be used up (`billing` null = not loaded yet, so the panel never
 * flashes while it loads). The power apps show their membership panel on
 * load only when this is false.
 */
export function creditCarriesOn(
  builtInCredit: boolean,
  billing: Pick<BillingSummary, 'availableMicros' | 'topUpsEnabled'> | null,
): boolean {
  return creditBuyable(builtInCredit, billing) || creditCanPay(builtInCredit, billing);
}

/**
 * More Tangent credit can be bought here: credit is offered and top-ups are
 * sold, read as `creditCarriesOn` reads them (only a summary saying
 * `topUpsEnabled: false` turns them off, so a summary not read yet counts as
 * selling). False where credit only comes from operator grants: an empty
 * balance then stays empty. `DefaultRouteFacts.creditBuyable` for the power
 * apps' default route.
 */
export function creditBuyable(
  builtInCredit: boolean,
  billing: Pick<BillingSummary, 'topUpsEnabled'> | null,
): boolean {
  return builtInCredit && billing?.topUpsEnabled !== false;
}

/**
 * Tangent credit can pay for a reply as far as the client knows: offered,
 * and a balance read and above zero. Unlike `creditCarriesOn`, neither a
 * balance not read yet nor one that could be bought counts: the default route of a new tree
 * (`pickDefaultRoute`) never starts on credit on a guess, since an empty
 * balance would answer its first send with a 402.
 */
export function creditCanPay(
  builtInCredit: boolean,
  billing: Pick<BillingSummary, 'availableMicros'> | null,
): boolean {
  return builtInCredit && billing !== null && billing.availableMicros > 0;
}

/**
 * The part of `BillingClient` that subscribes. The server picks the pages the
 * payment provider returns to: the billing page of the calling app.
 */
export interface MembershipUpgrader {
  upgrade(): Promise<void>;
}

/** Opens the membership's secure checkout; resolves only if the browser is not leaving. */
export function subscribeToMembership(billing: MembershipUpgrader): Promise<void> {
  return billing.upgrade();
}

/** `$10 / year plus tax` (prices are pre-tax; tax is added at checkout). */
export function membershipPriceText(m: Pick<MembershipInfo, 'priceCents'>): string {
  return `${formatCents(m.priceCents)} / year plus tax`;
}

/**
 * The yearly credit gift, or null when the server promises none (the
 * membership includes no credit today: the server sends 0, so nothing shows).
 */
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
    return "Not active. A membership lets you use your own API keys, in Learn and power mode, with your provider billing you directly. The open pool and Tangent credit don't need one, and your conversations stay readable either way.";
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

/**
 * A notice's Subscribe button (Learn's `KeyLockedNotice`): opens the secure
 * checkout, or says why it couldn't.
 */
export class MembershipSubscribe {
  /** Stays true on success: the page is leaving for the checkout (no double clicks meanwhile). */
  readonly pending = signal(false);
  readonly error = signal<string | null>(null);

  constructor(private readonly billing: MembershipUpgrader) {}

  async subscribe(): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    this.error.set(null);
    try {
      await subscribeToMembership(this.billing);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      this.pending.set(false);
    }
  }

  /** Back from the checkout through the back/forward cache: the button works again. */
  reset(): void {
    this.pending.set(false);
  }
}
