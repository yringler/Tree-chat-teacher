// Simple-account billing: markup and fee pass-through, spend gate, summary, usage history and
// credit top-ups (PLAN §2.3–2.6).
import { DomainError, PaymentRequiredError, ValidationError } from '@tangent/core';
import {
  MAX_TOP_UP_CENTS,
  MIN_TOP_UP_CENTS,
  type BillingSummary,
  type CheckoutResponse,
  type PurchaseInfo,
  type SubscriptionInfo,
  type UsageEntry,
  type UsageListResponse,
  type UsagePurpose,
} from '@tangent/shared';
import { isMetered, type AccountContext, type AppEnv } from '../env.js';
import { getBalance } from './ledger.js';
import { billingConfigured, ensureStripeCustomer, getStripe, stripePlans } from './stripe.js';

export const DEFAULT_USAGE_HOLD_MICROS = 20_000;
export const DEFAULT_MARKUP_PREPAID_BPS = 1000;
export const DEFAULT_MARKUP_MONTHLY_BPS = 500;
/** OpenRouter's fee on credit purchases (5.5%; higher for top-ups under ~$15, see README). */
export const DEFAULT_OPENROUTER_FEE_BPS = 550;
export const MAX_USAGE_PAGE = 100;

function intVar(raw: string | undefined, fallback: number): number {
  const s = raw?.trim();
  if (!s || !/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : fallback;
}

/** Per-call hold and minimum available balance (`USAGE_HOLD_MICROS`). */
export function usageHoldMicros(env: AppEnv): number {
  return intVar(env.USAGE_HOLD_MICROS, DEFAULT_USAGE_HOLD_MICROS);
}

/** OpenRouter's credit-purchase fee in bps (`OPENROUTER_FEE_BPS`), part of the provider cost. */
export function openRouterFeeBps(env: AppEnv): number {
  return intVar(env.OPENROUTER_FEE_BPS, DEFAULT_OPENROUTER_FEE_BPS);
}

/** True when the user has an `active` monthly plan (plugin `subscription` row). */
async function hasActiveSubscription(env: AppEnv, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const row = await env.DB.prepare(
    "SELECT 1 AS one FROM auth_subscriptions WHERE reference_id = ? AND status = 'active' LIMIT 1",
  )
    .bind(userId)
    .first<{ one: number }>();
  return row !== null;
}

/** Markup in bps: MARKUP_MONTHLY_BPS with an active subscription, else MARKUP_PREPAID_BPS. */
export async function markupFor(env: AppEnv, account: AccountContext): Promise<number> {
  const monthly = await hasActiveSubscription(env, account.userId);
  return monthly
    ? intVar(env.MARKUP_MONTHLY_BPS, DEFAULT_MARKUP_MONTHLY_BPS)
    : intVar(env.MARKUP_PREPAID_BPS, DEFAULT_MARKUP_PREPAID_BPS);
}

function notConfigured(): DomainError {
  return new DomainError('bad_request', 'Billing is not configured');
}

/**
 * Throws `PaymentRequiredError` (402) when a request on paid credit can't
 * start a metered call: available = balance − pending holds must cover one
 * more hold. Always a no-op for power mode and for Learn on the user's own key.
 */
export async function assertCanSpend(env: AppEnv, account: AccountContext): Promise<void> {
  if (!isMetered(account)) return;
  if (!billingConfigured(env)) throw notConfigured();
  const { balanceMicros, heldMicros } = await getBalance(env.DB, account.id);
  if (balanceMicros - heldMicros < usageHoldMicros(env)) throw new PaymentRequiredError();
}

interface SubscriptionRow {
  plan: string;
  status: string;
  period_end: number | null;
  cancel_at_period_end: number;
}

/** The most relevant plugin subscription row: active first, then the latest period. */
async function currentSubscription(
  env: AppEnv,
  userId: string | null,
): Promise<SubscriptionInfo | null> {
  if (!userId) return null;
  const row = await env.DB.prepare(
    `SELECT plan, status, period_end, cancel_at_period_end FROM auth_subscriptions
     WHERE reference_id = ? AND status NOT IN ('incomplete', 'incomplete_expired')
     ORDER BY (status = 'active') DESC, COALESCE(period_end, 0) DESC
     LIMIT 1`,
  )
    .bind(userId)
    .first<SubscriptionRow>();
  if (!row) return null;
  return {
    plan: row.plan,
    status: row.status,
    periodEnd: row.period_end === null ? null : new Date(row.period_end).toISOString(),
    cancelAtPeriodEnd: !!row.cancel_at_period_end,
  };
}

interface PurchaseRow {
  kind: 'purchase' | 'subscription';
  amount_micros: number;
  gross_micros: number;
  fee_micros: number;
  created_at: string;
}

/** The latest top-up or plan credit recorded with its gross amount and processing fee. */
async function lastPurchase(env: AppEnv, accountId: string): Promise<PurchaseInfo | null> {
  const row = await env.DB.prepare(
    `SELECT kind, amount_micros, gross_micros, fee_micros, created_at FROM credit_grants
     WHERE account_id = ? AND kind IN ('purchase', 'subscription') AND gross_micros IS NOT NULL
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(accountId)
    .first<PurchaseRow>();
  if (!row) return null;
  return {
    kind: row.kind,
    grossMicros: row.gross_micros,
    feeMicros: row.fee_micros,
    creditMicros: row.amount_micros,
    createdAt: row.created_at,
  };
}

export async function getBillingSummary(
  env: AppEnv,
  account: AccountContext,
): Promise<BillingSummary> {
  const [{ balanceMicros, heldMicros }, markupBps, subscription, purchase] = await Promise.all([
    getBalance(env.DB, account.id),
    markupFor(env, account),
    currentSubscription(env, account.userId),
    lastPurchase(env, account.id),
  ]);
  return {
    enabled: billingConfigured(env),
    topUpsEnabled: billingConfigured(env) && !!env.STRIPE_CREDITS_PRODUCT_ID?.trim(),
    currency: 'usd',
    balanceMicros,
    heldMicros,
    availableMicros: balanceMicros - heldMicros,
    markupBps,
    openRouterFeeBps: openRouterFeeBps(env),
    lastPurchase: purchase,
    subscription,
    monthlyPlans: stripePlans(env).map(({ name, label, amountCents }) => ({
      name,
      label,
      amountCents,
    })),
    minTopUpCents: MIN_TOP_UP_CENTS,
    maxTopUpCents: MAX_TOP_UP_CENTS,
  };
}

interface UsageRow {
  id: string;
  created_at: string;
  purpose: UsagePurpose;
  model: string;
  tree_id: string | null;
  status: UsageEntry['status'];
  charge_micros: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

function encodeCursor(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const [createdAt, id, ...rest] = atob(b64).split('|');
    if (createdAt && id && rest.length === 0) return { createdAt, id };
  } catch {
    // fall through
  }
  throw new ValidationError('Invalid cursor');
}

/** Newest first; `cursor` is the previous page's `nextCursor`. */
export async function listUsage(
  env: AppEnv,
  account: AccountContext,
  cursor: string | null,
  limit: number,
): Promise<UsageListResponse> {
  const size = Math.min(
    MAX_USAGE_PAGE,
    Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 50)),
  );
  const after = cursor ? decodeCursor(cursor) : null;
  const columns =
    'id, created_at, purpose, model, tree_id, status, charge_micros, input_tokens, output_tokens';
  const stmt = after
    ? env.DB.prepare(
        `SELECT ${columns} FROM usage_events
         WHERE account_id = ?1 AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
         ORDER BY created_at DESC, id DESC LIMIT ?4`,
      ).bind(account.id, after.createdAt, after.id, size + 1)
    : env.DB.prepare(
        `SELECT ${columns} FROM usage_events WHERE account_id = ?1
         ORDER BY created_at DESC, id DESC LIMIT ?2`,
      ).bind(account.id, size + 1);
  const { results } = await stmt.all<UsageRow>();
  const page = results.slice(0, size);
  const last = page.at(-1);
  return {
    entries: page.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      purpose: r.purpose,
      model: r.model,
      treeId: r.tree_id,
      status: r.status,
      chargeMicros: r.charge_micros,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    })),
    nextCursor: results.length > size && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

/** Creates a Stripe Checkout Session (mode `payment`) for a credit top-up. */
export async function createCreditCheckout(
  env: AppEnv,
  account: AccountContext,
  user: { id: string; email: string; name: string },
  amountCents: number,
  baseUrl: string,
): Promise<CheckoutResponse> {
  if (
    !Number.isInteger(amountCents) ||
    amountCents < MIN_TOP_UP_CENTS ||
    amountCents > MAX_TOP_UP_CENTS
  ) {
    throw new ValidationError(
      `amountCents must be a whole number from ${MIN_TOP_UP_CENTS} to ${MAX_TOP_UP_CENTS}`,
    );
  }
  if (account.mode !== 'simple')
    throw new DomainError('forbidden', 'Billing is only available in Learn mode');
  const stripe = getStripe(env);
  const productId = env.STRIPE_CREDITS_PRODUCT_ID?.trim();
  if (!billingConfigured(env) || !stripe || !productId) throw notConfigured();

  const customer = await ensureStripeCustomer(env, user);
  const base = baseUrl.replace(/\/+$/, '');
  const metadata = { kind: 'credits', accountId: account.id, amountCents: String(amountCents) };
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer,
    customer_update: { address: 'auto', name: 'auto' },
    billing_address_collection: 'required',
    automatic_tax: { enabled: true },
    invoice_creation: { enabled: true },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          product: productId,
          unit_amount: amountCents,
          tax_behavior: 'exclusive',
        },
      },
    ],
    client_reference_id: account.id,
    metadata,
    // Lets refunds (charge.refunded) find the account and the pre-tax share.
    payment_intent_data: { metadata },
    success_url: `${base}/learn/billing?checkout=success`,
    cancel_url: `${base}/learn/billing?checkout=cancel`,
  });
  if (!session.url) throw new Error('Stripe returned a Checkout Session without a URL');
  return { url: session.url };
}
