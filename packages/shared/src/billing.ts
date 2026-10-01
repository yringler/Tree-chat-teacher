import { z } from 'zod';
import type { UsagePurpose } from './provider.js';

/**
 * Simple-mode billing contract (prepaid credits and monthly credit plans).
 *
 * Units: the ledger is integer micro-USD (`MICROS_PER_USD`); top-ups are whole
 * US cents. Every amount shown to users is pre-tax (Stripe Tax adds tax at
 * checkout).
 */

/** `power`: the owner's shared account (own keys, unmetered). `simple`: a personal, metered account. */
export type AccountMode = 'power' | 'simple';

/** Smallest one-time top-up ($5.00). */
export const MIN_TOP_UP_CENTS = 500;
/** Largest one-time top-up ($500.00). */
export const MAX_TOP_UP_CENTS = 50_000;
/** Ledger units per US dollar. */
export const MICROS_PER_USD = 1_000_000;

export const createCheckoutRequestSchema = z.object({
  amountCents: z.number().int().min(MIN_TOP_UP_CENTS).max(MAX_TOP_UP_CENTS),
});
export type CreateCheckoutRequest = z.infer<typeof createCheckoutRequestSchema>;

/** Stripe Checkout URL to send the browser to. */
export interface CheckoutResponse {
  url: string;
}

/** A monthly credit plan offered through the Better Auth Stripe plugin. */
export interface MonthlyPlanInfo {
  /** Plugin plan name (`subscription.upgrade({ plan })`). */
  name: string;
  label: string;
  /** Display price per month (the credit granted comes from the paid invoice). */
  amountCents: number;
}

export interface SubscriptionInfo {
  plan: string;
  /** Stripe subscription status (`active`, `past_due`, `canceled`, ...). */
  status: string;
  /** ISO timestamp of the current period's end; null when unknown. */
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/** `GET /api/billing`. */
export interface BillingSummary {
  /** False when Stripe isn't configured on the server (no top-ups, no spending). */
  enabled: boolean;
  currency: 'usd';
  /** Credits minus settled charges (may be negative). */
  balanceMicros: number;
  /** Held by in-flight generations. */
  heldMicros: number;
  /** `balanceMicros - heldMicros`. */
  availableMicros: number;
  /** Markup applied to provider cost right now, in basis points (1000 = +10%). */
  markupBps: number;
  subscription: SubscriptionInfo | null;
  monthlyPlans: MonthlyPlanInfo[];
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
