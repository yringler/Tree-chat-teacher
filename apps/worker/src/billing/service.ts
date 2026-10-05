// Billing for the built-in provider: markup and fee pass-through, spend gate, summary, usage
// history and credit top-ups (PLAN §2.3–2.6, §13). The membership is in membership.ts. Credit is per user: every ledger read and
// write goes to `AccountContext.billingAccountId`, the same in both modes.
import { DomainError, PaymentRequiredError, ValidationError } from '@tangent/core';
import {
  MAX_TOP_UP_CENTS,
  MIN_TOP_UP_CENTS,
  type BillingSummary,
  type CheckoutResponse,
  type PurchaseInfo,
  type PurchaseTarget,
  type UsageEntry,
  type UsageListResponse,
  type UsagePurpose,
} from '@tangent/shared';
import { isMetered, type AccountContext, type AppEnv } from '../env.js';
import { builtInAvailable, personalCreditReady } from '../services.js';
import { getBalance } from './ledger.js';
import { membershipFor } from './membership.js';
import { billingConfigured, ensureStripeCustomer, getStripe } from './stripe.js';
import { appConfig } from '../config.js';

export {
  DEFAULT_MARKUP_BPS,
  DEFAULT_OPENROUTER_FEE_BPS,
  DEFAULT_USAGE_HOLD_MICROS,
  DEFAULT_USAGE_MAX_PENDING,
} from '../config.js';
export const MAX_USAGE_PAGE = 100;

/** Per-call hold and minimum available balance (`USAGE_HOLD_MICROS`). */
export function usageHoldMicros(env: AppEnv): number {
  return appConfig(env).billing.usageHoldMicros;
}

/**
 * Metered calls a user may have in flight at once (`USAGE_MAX_PENDING`). The
 * hold doesn't follow the model's price, so this is what bounds an overdraft:
 * at most this many calls, each within the built-in provider's token caps.
 */
export function usageMaxPending(env: AppEnv): number {
  return appConfig(env).billing.usageMaxPending;
}

/** OpenRouter's credit-purchase fee in bps (`OPENROUTER_FEE_BPS`), part of the provider cost. */
export function openRouterFeeBps(env: AppEnv): number {
  return appConfig(env).billing.openRouterFeeBps;
}

/**
 * Markup on the true provider cost, in bps: `MARKUP_BPS`; while that is empty
 * or malformed, the deprecated `MARKUP_PREPAID_BPS` (read for one release);
 * else 1000 (+10%). The same for every user: there are no plan discounts.
 */
export function markupFor(env: AppEnv): number {
  return appConfig(env).billing.markupBps;
}

function notConfigured(): DomainError {
  return new DomainError('bad_request', 'Billing is not configured');
}

/**
 * Throws `PaymentRequiredError` (402) when a call on `providerId` is metered
 * (the built-in provider, see `isMetered`) and the user's credit can't start
 * it: available = balance − pending holds must cover one more hold. Then
 * 429 `rate_limited` when `USAGE_MAX_PENDING` metered calls are already in
 * flight (pending usage rows), which bounds how far the balance can go
 * negative. A no-op for every call on the user's own keys, in either mode.
 */
export async function assertCanSpend(
  env: AppEnv,
  account: AccountContext,
  providerId: string,
): Promise<void> {
  if (!isMetered(account, providerId)) return;
  if (!personalCreditReady(env)) throw notConfigured();
  const { balanceMicros, heldMicros, pendingCalls } = await getBalance(
    env.DB,
    account.billingAccountId,
  );
  if (balanceMicros - heldMicros < usageHoldMicros(env)) throw new PaymentRequiredError();
  if (pendingCalls >= usageMaxPending(env))
    throw new DomainError(
      'rate_limited',
      'Too many replies are still running on Tangent credit. Wait for one to finish and try again.',
    );
}

interface PurchaseRow {
  kind: 'purchase' | 'subscription';
  amount_micros: number;
  gross_micros: number;
  fee_micros: number;
  created_at: string;
}

/**
 * The latest purchase recorded with its gross amount and processing fee: a
 * top-up, or a monthly-plan invoice on ledgers from before the membership.
 * Membership credit (gross null) is a gift, not a purchase, and is skipped.
 */
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

/** One-time credit purchases (top-ups, and funding the pool) can be sold: Stripe and its credits product are set up. */
export function topUpsEnabled(env: AppEnv): boolean {
  return billingConfigured(env) && !!env.STRIPE_CREDITS_PRODUCT_ID?.trim();
}

export async function getBillingSummary(
  env: AppEnv,
  account: AccountContext,
): Promise<BillingSummary> {
  const [{ balanceMicros, heldMicros }, membership, purchase] = await Promise.all([
    getBalance(env.DB, account.billingAccountId),
    membershipFor(env, account),
    lastPurchase(env, account.billingAccountId),
  ]);
  return {
    enabled: billingConfigured(env),
    membership,
    builtInCredit: builtInAvailable(env),
    topUpsEnabled: topUpsEnabled(env),
    currency: 'usd',
    balanceMicros,
    heldMicros,
    availableMicros: balanceMicros - heldMicros,
    markupBps: markupFor(env),
    openRouterFeeBps: openRouterFeeBps(env),
    lastPurchase: purchase,
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
      ).bind(account.billingAccountId, after.createdAt, after.id, size + 1)
    : env.DB.prepare(
        `SELECT ${columns} FROM usage_events WHERE account_id = ?1
         ORDER BY created_at DESC, id DESC LIMIT ?2`,
      ).bind(account.billingAccountId, size + 1);
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

/**
 * The page Stripe Checkout returns to: the billing page of the app the
 * checkout started from (`/billing` in power, `/learn/billing` in Learn).
 * A pool purchase adds `target=pool`, so the page waits for the pool's
 * balance instead of the buyer's.
 */
export function checkoutReturnUrl(
  baseUrl: string,
  account: AccountContext,
  outcome: 'success' | 'cancel',
  target: PurchaseTarget = 'personal',
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const page = account.mode === 'simple' ? '/learn/billing' : '/billing';
  return `${base}${page}?checkout=${outcome}${target === 'pool' ? '&target=pool' : ''}`;
}

/**
 * Creates a Stripe Checkout Session (mode `payment`) for a credit purchase, in
 * either mode: a top-up of the user's own credit, or (`target` `pool`, checked
 * by billing/purchases.ts) credit for the community pool. The metadata names
 * the target, the ledger credited and the buyer, for the webhook.
 */
export async function createCreditCheckout(
  env: AppEnv,
  account: AccountContext,
  user: { id: string; email: string; name: string },
  amountCents: number,
  baseUrl: string,
  target: PurchaseTarget = 'personal',
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
  const stripe = getStripe(env);
  const productId = env.STRIPE_CREDITS_PRODUCT_ID?.trim();
  if (!billingConfigured(env) || !stripe || !productId) throw notConfigured();

  const customer = await ensureStripeCustomer(env, user);
  // The user's ledger, whichever app the top-up was bought from; or the pool's.
  const accountId = target === 'pool' ? appConfig(env).pool.accountId : account.billingAccountId;
  const metadata = {
    kind: 'credits',
    target,
    accountId,
    userId: user.id,
    amountCents: String(amountCents),
  };
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
    client_reference_id: accountId,
    metadata,
    // Lets refunds and disputes find the account, the buyer and the pre-tax share.
    payment_intent_data: { metadata },
    success_url: checkoutReturnUrl(baseUrl, account, 'success', target),
    cancel_url: checkoutReturnUrl(baseUrl, account, 'cancel', target),
  });
  if (!session.url) throw new Error('Stripe returned a Checkout Session without a URL');
  return { url: session.url };
}
