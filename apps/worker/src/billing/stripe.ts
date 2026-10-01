// Wave 1 stub (foundation). Implemented in wave 2 by the `billing` agent.
import type Stripe from 'stripe';
import type { AppEnv } from '../env.js';

/** A monthly credit plan from the `STRIPE_PLANS` var (Better Auth Stripe plugin plan). */
export interface StripePlanConfig {
  /** Plugin plan name (`subscription.upgrade({ plan })`). */
  name: string;
  label: string;
  /** Stripe recurring price id (`price_…`). */
  priceId: string;
  /** Display price per month; the credit granted comes from the paid invoice's subtotal. */
  amountCents: number;
}

/** Stripe client for this env; null when `STRIPE_SECRET_KEY` is unset. */
export function getStripe(_env: AppEnv): Stripe | null {
  throw new Error('not implemented');
}

/** True when both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set. */
export function billingConfigured(_env: AppEnv): boolean {
  throw new Error('not implemented');
}

/** Parses `STRIPE_PLANS` (empty or `[]` = no monthly plans). */
export function stripePlans(_env: AppEnv): StripePlanConfig[] {
  throw new Error('not implemented');
}
