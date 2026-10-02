// Stripe client and billing configuration (PLAN §2.3, §2.9).
import Stripe from 'stripe';
import type { AppEnv } from '../env.js';

/** The API version stripe@22.6.2 pins; create the webhook endpoint on the same one. */
export const STRIPE_API_VERSION = '2026-08-26.dahlia' satisfies Stripe.LatestApiVersion;

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

function isPlan(v: unknown): v is StripePlanConfig {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p['name'] === 'string' &&
    p['name'] !== '' &&
    typeof p['label'] === 'string' &&
    typeof p['priceId'] === 'string' &&
    p['priceId'] !== '' &&
    typeof p['amountCents'] === 'number' &&
    Number.isInteger(p['amountCents']) &&
    p['amountCents'] > 0
  );
}

/**
 * Parses `STRIPE_PLANS` (empty or `[]` = no monthly plans). Malformed JSON or
 * entries are logged and skipped rather than taking the Worker down.
 */
export function stripePlans(env: AppEnv): StripePlanConfig[] {
  const raw = env.STRIPE_PLANS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('STRIPE_PLANS is not valid JSON; no monthly plans offered');
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error('STRIPE_PLANS must be a JSON array; no monthly plans offered');
    return [];
  }
  const plans: StripePlanConfig[] = [];
  for (const entry of parsed) {
    if (!isPlan(entry)) {
      console.error('STRIPE_PLANS: skipping an invalid plan entry');
      continue;
    }
    plans.push({
      name: entry.name,
      label: entry.label,
      priceId: entry.priceId,
      amountCents: entry.amountCents,
    });
  }
  return plans;
}

/** The personal (simple) account id of a Better Auth user (PLAN §2.1). */
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

/**
 * The user's Stripe customer id, creating the customer on first use (lazy:
 * no Stripe calls for the owner or for sign-ups that never pay). Uses the
 * plugin's metadata keys so `subscription.upgrade` and the billing portal
 * recognise the customer, and an idempotency key so concurrent first
 * checkouts can't create two customers.
 */
export async function ensureStripeCustomer(
  env: AppEnv,
  user: { id: string; email: string; name: string },
): Promise<string> {
  const stripe = getStripe(env);
  if (!stripe) throw new Error('Stripe is not configured');
  const existing = await env.DB.prepare(
    'SELECT stripe_customer_id AS cid FROM auth_users WHERE id = ?',
  )
    .bind(user.id)
    .first<{ cid: string | null }>();
  if (existing?.cid) return existing.cid;

  const customer = await stripe.customers.create(
    {
      email: user.email,
      ...(user.name ? { name: user.name } : {}),
      metadata: { userId: user.id, customerType: 'user' },
    },
    { idempotencyKey: `customer-${user.id}` },
  );
  // Only fill an empty slot: if a concurrent request (or the plugin) won, keep its id.
  await env.DB.prepare(
    'UPDATE auth_users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL',
  )
    .bind(customer.id, user.id)
    .run();
  const stored = await env.DB.prepare(
    'SELECT stripe_customer_id AS cid FROM auth_users WHERE id = ?',
  )
    .bind(user.id)
    .first<{ cid: string | null }>();
  return stored?.cid ?? customer.id;
}
