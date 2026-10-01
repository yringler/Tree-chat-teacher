// Wave 1 stub (foundation). Implemented in wave 2 by the `billing` agent.
import type Stripe from 'stripe';
import type { AppEnv } from '../env.js';

/**
 * The Better Auth Stripe plugin's `onEvent`: credits top-ups and subscription
 * invoices, debits refunds (idempotent). Throws on D1 errors so Stripe retries.
 */
export function handleStripeEvent(_env: AppEnv, _event: Stripe.Event): Promise<void> {
  throw new Error('not implemented');
}
