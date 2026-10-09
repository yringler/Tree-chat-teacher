import { z } from './zod.js';
import type { UsagePurpose } from './provider.js';

/**
 * Billing contract: the yearly membership (once the operator sets it up,
 * required for generating on the user's own keys, in Learn and power alike;
 * the open pool and Tangent credit, bought or spent, never need it) and
 * prepaid credit for the built-in provider.
 * Credit and membership are per user and shared by both apps.
 *
 * Units: the ledger is integer micro-USD (`MICROS_PER_USD`); top-ups are whole
 * US cents. Every amount shown to users is pre-tax (the payment provider adds
 * tax at checkout).
 */

/**
 * Which app a request comes from. It picks how replies are generated and paid
 * for, never which conversations the user sees: every user has one account.
 * - `power`: the full app at `/`: the user's own keys (unmetered), plus the
 *   built-in provider on credit where the server offers it.
 * - `simple`: Tangent Learn at `/learn/`, on the user's own OpenRouter key,
 *   on credit or on the open pool (`Payer`, per request).
 */
export type AccountMode = 'power' | 'simple';

/** Request header naming the app (`AccountMode`); absent = `power`. */
export const MODE_HEADER = 'x-tangent-mode';
/** Request header with the `Payer` of a `simple` request; absent = `own-key`. */
export const PAYMENT_HEADER = 'x-tangent-payment';

/** Smallest one-time top-up ($5.00). */
export const MIN_TOP_UP_CENTS = 500;
/** Largest one-time top-up ($500.00). */
export const MAX_TOP_UP_CENTS = 50_000;
/** Ledger units per US dollar. */
export const MICROS_PER_USD = 1_000_000;

/**
 * `POST /api/billing/checkout`: credit for the buyer's own account. The
 * purchase adds what was paid (pre-tax) minus the processing fee; the
 * operator earns a markup on usage instead (`MARKUP_BPS`). Nobody buys credit
 * for the open pool (`POOL_FUNDING_TEXT`, pool.ts), so a body naming any other
 * field, such as a `target`, is refused.
 */
export const createCheckoutRequestSchema = z
  .object({
    amountCents: z.number().int().min(MIN_TOP_UP_CENTS).max(MAX_TOP_UP_CENTS),
  })
  .strict();
/** What a client sends. */
export type CreateCheckoutRequest = z.input<typeof createCheckoutRequestSchema>;

/** The payment provider's hosted page (checkout or billing portal) to send the browser to. */
export interface CheckoutResponse {
  url: string;
}

/** `POST /api/billing/portal`: the billing portal to send the browser to. */
export type PortalResponse = CheckoutResponse;

export const membershipWaiverRequestSchema = z.object({
  code: z.string().trim().min(1).max(200),
});
/** `POST /api/billing/membership/waiver`: redeem the operator's code to waive the fee. */
export type MembershipWaiverRequest = z.infer<typeof membershipWaiverRequestSchema>;

/**
 * A subscription's status, normalised from the payment provider's own
 * vocabulary (the server maps each provider's statuses onto these):
 * - `trialing`, `active`: paid up (or in a trial);
 * - `past_due`: a renewal failed and the provider is still retrying;
 * - `unpaid`, `paused`, `incomplete`: not paid; `canceled`: ended.
 */
export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
  'incomplete',
  'canceled',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * Where the user stands with the yearly membership:
 * - `active`: the membership subscription is `active`, `trialing` or
 *   `past_due` (the payment provider is still retrying a failed renewal);
 * - `waived`: the operator waived the fee for this user (it wins over the subscription);
 * - `inactive`: neither; while `required` is true, generating on the user's
 *   own keys (Learn or power) answers 402 `membership_required`. The open
 *   pool, credit (buying and spending), reading, exporting and deleting stay open.
 */
export type MembershipStatus = 'active' | 'waived' | 'inactive';

export interface MembershipInfo {
  /**
   * True when the membership is required (generating on own keys): the annual fee is on
   * (`ANNUAL_FEE_ENABLED`) and the payment provider sells the membership. False in the local dev bypass and on
   * servers without billing; the other fields then carry no meaning.
   */
  required: boolean;
  status: MembershipStatus;
  /**
   * The membership subscription's status, normalised from the payment
   * provider's (`active`, `past_due`, `canceled`, ...); null when there is none.
   */
  subscriptionStatus: SubscriptionStatus | null;
  /** ISO timestamp of the current period's end; null when unknown. */
  periodEnd: string | null;
  /** The subscription ends at `periodEnd` (cancelled in the billing portal). */
  cancelAtPeriodEnd: boolean;
  /** Display price per year, pre-tax (tax is added at checkout). */
  priceCents: number;
}

/** The latest top-up with a known processing fee. */
export interface PurchaseInfo {
  /** Pre-tax amount paid. */
  grossMicros: number;
  /** The payment provider's processing fee, deducted from the credit. */
  feeMicros: number;
  /** Credit added: `grossMicros - feeMicros`. */
  creditMicros: number;
  createdAt: string;
}

/** `GET /api/billing`. */
export interface BillingSummary {
  /** False when no payment provider is configured on the server (no top-ups, no spending). */
  enabled: boolean;
  /** The user's membership, as `MeResponse.membership`. */
  membership: MembershipInfo;
  /**
   * True when the built-in provider is offered on credit (billing and the
   * operator's OpenRouter key set up), as `MeResponse.builtInCredit`.
   */
  builtInCredit: boolean;
  /**
   * False when one-time top-ups can't be sold (the provider sells no credits
   * product), even though billing is enabled. Absent = assume they can.
   */
  topUpsEnabled?: boolean;
  currency: 'usd';
  /** The user's credits minus settled charges (may be negative); the same in both apps. */
  balanceMicros: number;
  /** Held by in-flight generations. */
  heldMicros: number;
  /** `balanceMicros - heldMicros`. */
  availableMicros: number;
  /** Markup applied to the true provider cost, in basis points (1000 = +10%). */
  markupBps: number;
  /**
   * OpenRouter's credit-purchase fee, in basis points (550 = 5.5%), included in
   * the provider cost before the markup: charge = price × (1 + fee) × (1 + markup).
   */
  openRouterFeeBps: number;
  /** The latest purchase whose processing fee is known; absent or null when none. */
  lastPurchase?: PurchaseInfo | null;
  minTopUpCents: number;
  maxTopUpCents: number;
}

/** One metered provider call. */
export interface UsageEntry {
  id: string;
  createdAt: string;
  purpose: UsagePurpose;
  model: string;
  treeId: string | null;
  status: 'pending' | 'settled' | 'unresolved';
  /** Null while pending. */
  chargeMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Web searches the call ran (grounding); included in `chargeMicros`. */
  webSearches: number;
}

/** `GET /api/billing/usage`, newest first. */
export interface UsageListResponse {
  entries: UsageEntry[];
  /** Pass as `cursor` for the next page; null when there are no more entries. */
  nextCursor: string | null;
}
