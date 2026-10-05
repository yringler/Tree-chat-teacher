import { z } from 'zod';
import type { UsagePurpose } from './provider.js';

/**
 * Billing contract: the yearly membership (required to generate in either app
 * once the operator sets it up) and prepaid credit for the built-in provider.
 * Credit and membership are per user and shared by both apps.
 *
 * Units: the ledger is integer micro-USD (`MICROS_PER_USD`); top-ups are whole
 * US cents. Every amount shown to users is pre-tax (Stripe Tax adds tax at
 * checkout).
 */

/**
 * Which app a request comes from. Every user has one account per mode, so the
 * two apps keep separate conversations.
 * - `power`: the full app at `/`: the user's own keys (unmetered), plus the
 *   built-in provider on credit where the server offers it.
 * - `simple`: Tangent Learn at `/learn/`, on the user's own OpenRouter key or
 *   on credit (`LearnPayment`).
 */
export type AccountMode = 'power' | 'simple';

/**
 * How a Learn (simple) request pays for its model calls:
 * - `own-key`: the user's own OpenRouter key (the `openrouter` entry of the
 *   sealed key cookie). Free; nothing is metered.
 * - `credit`: the built-in provider on the operator's key, metered and charged
 *   to the user's prepaid credit. Only offered when the server has billing and
 *   the operator key configured (`MeResponse.builtInCredit`). A send (or a
 *   context resolve) whose credit can't cover one call falls back to the
 *   community pool where it is on; reviews never do.
 * - `pool`: the community pool (pool.ts): one economical model, a locked
 *   system prompt and capped output, within daily caps. The server decides
 *   what a pool request may do; power mode never uses the pool.
 */
export type LearnPayment = 'own-key' | 'credit' | 'pool';

/** Request header naming the app (`AccountMode`); absent = `power`. */
export const MODE_HEADER = 'x-tangent-mode';
/** Request header with the `LearnPayment` of a `simple` request; absent = `own-key`. */
export const PAYMENT_HEADER = 'x-tangent-payment';
/** Key-cookie entry that Learn mode uses as the user's own key (shared with power mode's OpenRouter). */
export const LEARN_KEY_PROVIDER = 'openrouter';

/** Smallest one-time top-up ($5.00). */
export const MIN_TOP_UP_CENTS = 500;
/** Largest one-time top-up ($500.00). */
export const MAX_TOP_UP_CENTS = 50_000;
/** Ledger units per US dollar. */
export const MICROS_PER_USD = 1_000_000;

/**
 * What a credit purchase buys:
 * - `personal`: credit on the buyer's own ledger (net of Stripe's fee);
 * - `pool`: credit in the community pool (pool.ts), net of the pool margin.
 *   At least the pool minimum (`POOL_MIN_PURCHASE_CENTS`, default $10), so
 *   the margin covers card processing.
 */
export const PURCHASE_TARGETS = ['personal', 'pool'] as const;
export type PurchaseTarget = (typeof PURCHASE_TARGETS)[number];

/** The amounts the billing page offers for funding the community pool. */
export const POOL_FUND_PRESETS_CENTS: readonly number[] = [1000, 2000, 5000];

/** `POST /api/billing/checkout`; `target` defaults to `personal` (older clients send none). */
export const createCheckoutRequestSchema = z.object({
  amountCents: z.number().int().min(MIN_TOP_UP_CENTS).max(MAX_TOP_UP_CENTS),
  target: z.enum(PURCHASE_TARGETS).default('personal'),
});
/** What a client sends (`target` optional). */
export type CreateCheckoutRequest = z.input<typeof createCheckoutRequestSchema>;

/** Stripe Checkout URL to send the browser to. */
export interface CheckoutResponse {
  url: string;
}

export const membershipWaiverRequestSchema = z.object({
  code: z.string().trim().min(1).max(200),
});
/** `POST /api/billing/membership/waiver`: redeem the operator's code to waive the fee. */
export type MembershipWaiverRequest = z.infer<typeof membershipWaiverRequestSchema>;

/** The Better Auth Stripe plugin's plan name of the membership (`subscription.upgrade({ plan })`). */
export const MEMBERSHIP_PLAN = 'membership';

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
 *   `past_due` (Stripe is still retrying a failed renewal);
 * - `waived`: the operator waived the fee for this user (it wins over Stripe);
 * - `inactive`: neither; generating answers 402 `membership_required` while
 *   `required` is true. Reading, exporting and deleting stay open.
 */
export type MembershipStatus = 'active' | 'waived' | 'inactive';

export interface MembershipInfo {
  /**
   * True when generating needs a membership: billing and the membership price
   * are configured on the server. False in the local dev bypass and on
   * servers without billing; the other fields then carry no meaning.
   */
  required: boolean;
  status: MembershipStatus;
  /** Status of the membership subscription in Stripe (`active`, `past_due`, `canceled`, ...); null when none. */
  stripeStatus: string | null;
  /** ISO timestamp of the current period's end; null when unknown. */
  periodEnd: string | null;
  /** The subscription ends at `periodEnd` (cancelled in the Customer Portal). */
  cancelAtPeriodEnd: boolean;
  /** Display price per year, pre-tax (Stripe Tax adds tax at checkout). */
  priceCents: number;
  /**
   * Credit granted with each paid membership year; 0 when the server doesn't
   * offer the built-in provider (no credit is then promised or granted).
   */
  includedCreditCents: number;
}

/**
 * The latest credit purchase with a known processing fee: a top-up (or, on
 * older ledgers, a monthly-plan invoice). Credit included with the membership
 * is a fixed gift, not a purchase, and never shows here.
 */
export interface PurchaseInfo {
  kind: 'purchase' | 'subscription';
  /** Pre-tax amount paid. */
  grossMicros: number;
  /** Stripe's payment processing fee, deducted from the credit. */
  feeMicros: number;
  /** Credit added: `grossMicros - feeMicros`. */
  creditMicros: number;
  createdAt: string;
}

/** `GET /api/billing`. */
export interface BillingSummary {
  /** False when Stripe isn't configured on the server (no top-ups, no spending). */
  enabled: boolean;
  /** The user's membership, as `MeResponse.membership`. */
  membership: MembershipInfo;
  /**
   * True when the built-in provider is offered on credit (billing and the
   * operator's OpenRouter key set up), as `MeResponse.builtInCredit`.
   */
  builtInCredit: boolean;
  /**
   * False when one-time top-ups can't be sold (no `STRIPE_CREDITS_PRODUCT_ID`),
   * even though billing is enabled. Absent = assume they can.
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
}

/** `GET /api/billing/usage`, newest first. */
export interface UsageListResponse {
  entries: UsageEntry[];
  /** Pass as `cursor` for the next page; null when there are no more entries. */
  nextCursor: string | null;
}
