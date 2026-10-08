// Billing for the built-in provider: markup and fee pass-through, spend gate, summary, usage
// history and credit top-ups (PLAN §2.3–2.6, §13), sold through the payment provider's port
// (billing/payments). The membership is in membership.ts. Credit is per user: every ledger read and
// write goes to `AccountContext.billingAccountId`, the same in both modes.
import { DomainError, PaymentRequiredError, ValidationError } from '@tangent/core';
import {
  MAX_TOP_UP_CENTS,
  MIN_TOP_UP_CENTS,
  type BillingSummary,
  type BranchFunding,
  type CheckoutResponse,
  type PurchaseInfo,
  type UsageEntry,
  type UsageListResponse,
  type UsagePurpose,
} from '@tangent/shared';
import type { ModelPrice } from '../config.js';
import { isMetered, type AccountContext, type AppEnv } from '../env.js';
import { chargeFromTokensMicros, inputBoundTokens, type InputOf } from '../pool/pricing.js';
import { builtInAvailable, personalCreditReady } from '../services.js';
import { getBalance } from './ledger.js';
import { membershipFor } from './membership.js';
import { buyerFor, rememberCustomer } from './payments/customers.js';
import { paymentProvider, paymentsConfigured } from './payments/index.js';
import { reservePersonalUsage } from './usage-store.js';
import { appConfig } from '../config.js';

const MAX_USAGE_PAGE = 100;

/**
 * The least a credit call holds, and the available balance a send needs to
 * start (`USAGE_HOLD_MICROS`); a call on a pricier model holds its own worst
 * case (`creditHoldMicros`).
 */
export function usageHoldMicros(env: AppEnv): number {
  return appConfig(env).billing.usageHoldMicros;
}

/**
 * Credit calls a user may start and have in flight at once
 * (`USAGE_MAX_PENDING`): replies, reviews and compare candidates. The
 * summaries and titles of one ride on it, bounded by the balance alone.
 */
export function usageMaxPending(env: AppEnv): number {
  return appConfig(env).billing.usageMaxPending;
}

/**
 * What a credit call on a model at `price` holds: its worst case, `request`'s
 * input bound (pool/pricing.ts `inputBoundTokens`, in UTF-8 bytes) at the most
 * an input token can cost plus `maxOutputTokens` out, with the fee and the
 * markup, rounded up; never below `USAGE_HOLD_MICROS`. Web searches are not
 * priced in: the floor covers one.
 */
export function creditHoldMicros(
  env: AppEnv,
  price: ModelPrice,
  request: InputOf,
  maxOutputTokens: number,
  rates: { markupBps: number; feeBps: number },
): number {
  const worst = chargeFromTokensMicros(
    price,
    inputBoundTokens(request),
    maxOutputTokens,
    rates.feeBps,
    rates.markupBps,
  );
  return Math.max(usageHoldMicros(env), worst);
}

const TOO_MANY_PENDING =
  'Too many replies are still running on Tangent credit. Wait for one to finish and try again.';

/** The error of a model that can't run on credit because its price isn't known. */
export function unpricedOnCredit(model: string): DomainError {
  return new DomainError(
    'bad_request',
    `${model} can't run on Tangent credit: its price isn't known yet. Pick another model.`,
  );
}

/**
 * Why a credit reservation of `holdMicros` was refused: 402 when the
 * available balance can't cover it, else 429 `rate_limited` (too many calls
 * in flight). Read after the refusal, so a race can only change which.
 */
export async function creditRefusal(
  env: AppEnv,
  billingAccountId: string,
  holdMicros: number,
): Promise<DomainError> {
  const { balanceMicros, heldMicros } = await getBalance(env.DB, billingAccountId);
  if (balanceMicros - heldMicros < holdMicros) return new PaymentRequiredError();
  return new DomainError('rate_limited', TOO_MANY_PENDING);
}

/**
 * Reserves a credit reply before its nodes are written (the tree's Durable
 * Object, under its send lock): a pending row of `USAGE_HOLD_MICROS`, taken
 * only while the balance covers it and fewer than `USAGE_MAX_PENDING` calls
 * are in flight, in one statement, so sends racing on several trees can't
 * all pass. The meter then holds the reply at its own worst case
 * (`repriceReservation`). Resolves the row's id; throws 402 or 429.
 */
export async function reserveCreditReply(
  env: AppEnv,
  account: AccountContext,
  target: { treeId: string; branchId: string; providerId: string; model: string },
): Promise<string> {
  const id = crypto.randomUUID();
  const holdMicros = usageHoldMicros(env);
  const reserved = await reservePersonalUsage(
    env.DB,
    {
      id,
      accountId: account.billingAccountId,
      treeId: target.treeId,
      nodeId: null,
      branchId: target.branchId,
      userId: account.userId,
      purpose: 'reply',
      providerId: target.providerId,
      model: target.model,
      holdMicros,
      markupBps: markupFor(env),
      feeBps: openRouterFeeBps(env),
      createdAt: new Date().toISOString(),
    },
    usageMaxPending(env),
  );
  if (!reserved) throw await creditRefusal(env, account.billingAccountId, holdMicros);
  return id;
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
 * The early check of a request on a route of `funding`, before anything is
 * written or streamed: when it is metered (Tangent credit, see `isMetered`),
 * 402 `payment_required` unless the available balance (balance − pending
 * holds) covers one more `USAGE_HOLD_MICROS`, then 429 `rate_limited` when
 * `USAGE_MAX_PENDING` credit calls are in flight. It is a read, so requests
 * racing past it are stopped by the reservation each call takes in one
 * statement (`reserveCreditReply`, the meter's `reservePersonalUsage`). A
 * no-op for every call on the user's own keys, in either mode.
 */
export async function assertCanSpend(
  env: AppEnv,
  account: AccountContext,
  funding: BranchFunding,
): Promise<void> {
  if (!isMetered(account, funding)) return;
  if (!personalCreditReady(env)) throw notConfigured();
  const { balanceMicros, heldMicros, pendingCalls } = await getBalance(
    env.DB,
    account.billingAccountId,
  );
  if (balanceMicros - heldMicros < usageHoldMicros(env)) throw new PaymentRequiredError();
  if (pendingCalls >= usageMaxPending(env)) throw new DomainError('rate_limited', TOO_MANY_PENDING);
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
  web_searches: number | null;
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
    'id, created_at, purpose, model, tree_id, status, charge_micros, input_tokens, output_tokens, web_searches';
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
      webSearches: r.web_searches ?? 0,
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
 * own credit, in either mode. Anyone signed in may buy credit, member or not
 * (the membership is only for the user's own keys; credit carries the
 * markup instead). The provider carries the ledger to credit and the buyer to
 * its webhook (billing/payments/apply.ts).
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
