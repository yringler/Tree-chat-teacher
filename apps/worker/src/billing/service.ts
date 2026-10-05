// Billing for the built-in provider: markup and fee pass-through, spend gate, summary, usage
// history and credit top-ups (PLAN §2.3–2.6, §13), sold through the payment provider's port
// (billing/payments). The membership is in membership.ts. Credit is per user: every ledger read and
// write goes to `AccountContext.billingAccountId`, the same in both modes.
import { DomainError, PaymentRequiredError, ValidationError } from '@tangent/core';
import {
  MAX_TOP_UP_CENTS,
  MIN_TOP_UP_CENTS,
  type BillingSummary,
  type CheckoutResponse,
  type PurchaseInfo,
  type UsageEntry,
  type UsageListResponse,
  type UsagePurpose,
} from '@tangent/shared';
import { isMetered, type AccountContext, type AppEnv } from '../env.js';
import { builtInAvailable, personalCreditReady } from '../services.js';
import { getBalance } from './ledger.js';
import { membershipFor } from './membership.js';
import { buyerFor, rememberCustomer } from './payments/customers.js';
import { paymentProvider, paymentsConfigured } from './payments/index.js';
import { appConfig } from '../config.js';

const MAX_USAGE_PAGE = 100;

/** Per-call hold and minimum available balance (`USAGE_HOLD_MICROS`). */
export function usageHoldMicros(env: AppEnv): number {
  return appConfig(env).billing.usageHoldMicros;
}

/**
 * Metered calls a user may have in flight at once (`USAGE_MAX_PENDING`). The
 * hold doesn't follow the model's price, so this is what bounds an overdraft:
 * at most this many calls, each within the built-in provider's token caps.
 */
function usageMaxPending(env: AppEnv): number {
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
 * top-up, or a Stripe-era monthly-plan payment on ledgers from before the
 * membership.
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

/** One-time credit purchases (top-ups) can be sold: the payment provider sells credit. */
function topUpsEnabled(env: AppEnv): boolean {
  return paymentProvider(env)?.capabilities.topUps ?? false;
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
    enabled: paymentsConfigured(env),
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
 * The page the payment provider's checkout returns to: the billing page of
 * the app the checkout started from (`/billing` in power, `/learn/billing` in
 * Learn).
 */
export function checkoutReturnUrl(
  baseUrl: string,
  account: AccountContext,
  outcome: 'success' | 'cancel',
): string {
  return `${billingPageUrl(baseUrl, account)}?checkout=${outcome}`;
}

/** The billing page of the app `account` is in, where the billing portal returns to. */
export function billingPageUrl(baseUrl: string, account: AccountContext): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${account.mode === 'simple' ? '/learn/billing' : '/billing'}`;
}

/**
 * Opens the payment provider's hosted checkout for a top-up of the user's
 * own credit, in either mode. The provider carries the ledger to credit and
 * the buyer to its webhook (billing/payments/apply.ts).
 */
export async function startTopUpCheckout(
  env: AppEnv,
  account: AccountContext,
  userId: string,
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
  const provider = paymentProvider(env);
  if (!provider?.capabilities.topUps) throw notConfigured();
  const buyer = await buyerFor(env.DB, provider.id, userId);
  if (!buyer) throw new DomainError('unauthorized', 'Sign in to add credit');
  // The user's ledger, whichever app the top-up was bought from.
  const session = await provider.createTopUpCheckout({
    buyer,
    accountId: account.billingAccountId,
    amountCents,
    successUrl: checkoutReturnUrl(baseUrl, account, 'success'),
    cancelUrl: checkoutReturnUrl(baseUrl, account, 'cancel'),
  });
  if (session.customerRef) await rememberCustomer(env.DB, provider.id, userId, session.customerRef);
  return { url: session.url };
}
