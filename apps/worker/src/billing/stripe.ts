// Stripe client and billing configuration (PLAN §2.3, §2.9).
import Stripe from 'stripe';
import type { AppEnv } from '../env.js';

/** The API version stripe@22.6.2 pins; create the webhook endpoint on the same one. */
export const STRIPE_API_VERSION = '2026-08-26.dahlia' satisfies Stripe.LatestApiVersion;

// One client per secret key per isolate (the client holds no request state).
const clients = new Map<string, Stripe>();

/** Stripe client for this env; null when `STRIPE_SECRET_KEY` is unset. */
export function getStripe(env: AppEnv): Stripe | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  let client = clients.get(key);
  if (!client) {
    client = new Stripe(key, {
      apiVersion: STRIPE_API_VERSION,
      // The workerd build already defaults to fetch; explicit for vitest-pool-workers.
      httpClient: Stripe.createFetchHttpClient(),
    });
    clients.set(key, client);
  }
  return client;
}

/** True when both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set. */
export function billingConfigured(env: AppEnv): boolean {
  return !!env.STRIPE_SECRET_KEY?.trim() && !!env.STRIPE_WEBHOOK_SECRET?.trim();
}

/**
 * The membership's Stripe price (`STRIPE_MEMBERSHIP_PRICE_ID`, a yearly
 * recurring price); null when unset, i.e. no membership is sold or required.
 */
export function membershipPriceId(env: AppEnv): string | null {
  return env.STRIPE_MEMBERSHIP_PRICE_ID?.trim() || null;
}

/**
 * A Better Auth user's Learn account id, `u_<userId>`, which is also the
 * ledger id of their credit in both modes (`AccountContext.billingAccountId`).
 */
export function accountIdForUser(userId: string): string {
  return `u_${userId}`;
}

/** Better Auth user id whose `auth_users.stripe_customer_id` is `customerId`, if any. */
export async function userIdForCustomer(
  db: D1Database,
  customerId: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT id FROM auth_users WHERE stripe_customer_id = ? LIMIT 1')
    .bind(customerId)
    .first<{ id: string }>();
  return row?.id ?? null;
}
