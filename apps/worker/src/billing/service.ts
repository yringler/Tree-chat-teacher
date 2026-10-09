// Billing for the built-in provider: markup and fee pass-through, spend gate, summary, usage
// history and credit top-ups, sold through the payment provider's port
// (billing/payments). The membership is in membership.ts. Credit is per user: every ledger read and
// write goes to `AccountContext.billingAccountId`, the same in both modes.
import {
  CHARS_PER_TOKEN,
  DomainError,
  estimateTokens,
  MESSAGE_OVERHEAD_TOKENS,
  PaymentRequiredError,
  ValidationError,
} from '@tangent/core';
import {
  formatMicros,
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
import { creditPrice } from '../pool/model-prices.js';
import { chargeFromTokensMicros, renderAllowanceBytes, type InputOf } from '../pool/pricing.js';
import { builtInAvailable, personalCreditReady } from '../services.js';
import { getBalance } from './ledger.js';
import { membershipFor } from './membership.js';
import { buyerFor, rememberCustomer } from './payments/customers.js';
import { paymentProvider, paymentsConfigured } from './payments/index.js';
import { reservePersonalUsage } from './usage-store.js';
import { appConfig } from '../config.js';

const MAX_USAGE_PAGE = 100;

/**
 * The least a credit call holds ($0.02), and the available balance a send
 * needs to start; a call on a pricier model holds its own worst case
 * (`creditHoldMicros`). Only a reservation: the charge is the call's cost.
 */
export const USAGE_HOLD_MICROS = 20_000;

/**
 * Credit calls a user may start and have in flight at once: replies, reviews
 * and compare candidates, as many as canvas fans out at once (one more is
 * 429). The summaries and titles of one ride on it, bounded by the balance
 * alone.
 */
export const USAGE_MAX_PENDING = 6;

/**
 * The input tokens of `request` as credit holds count them: core's estimate
 * (chars / 3.5, `estimateTokens`) with message framing, the measure credit's
 * input budget is in, so a reply's prompt is within the budget its
 * reservation was priced on (`replyInputTokens`). An estimate, not a hard
 * bound like the pool's bytes: the charge is the reported cost, and what an
 * estimate misses (dense scripts, a route dearer than the list price) is the
 * overdraft a hold allows.
 */
export function estimatedInputTokens(request: InputOf): number {
  const messages = request.messages.map((m) => m.content);
  if (request.turnInstructions) messages.push(request.turnInstructions);
  let tokens = request.system === null ? 0 : estimateTokens(request.system);
  for (const text of messages) tokens += estimateTokens(text) + MESSAGE_OVERHEAD_TOKENS;
  return tokens;
}

/**
 * The input a reply with an input budget of `maxInputTokens` can send, in
 * `estimatedInputTokens`' measure: the budget plus what rendering adds
 * outside it (headings, anchor tags, per-reply instructions, framing).
 */
export function replyInputTokens(maxInputTokens: number): number {
  return maxInputTokens + Math.ceil(renderAllowanceBytes() / CHARS_PER_TOKEN);
}

/**
 * What a credit call on a model at `price` holds: its worst case,
 * `inputTokens` at the most an input token can cost plus `maxOutputTokens`
 * out, with the fee and the markup, rounded up; never below
 * `USAGE_HOLD_MICROS`. Web searches are not priced in: the floor covers one.
 */
export function creditHoldMicros(
  env: AppEnv,
  price: ModelPrice,
  inputTokens: number,
  maxOutputTokens: number,
  rates: { markupBps: number; feeBps: number },
): number {
  const worst = chargeFromTokensMicros(
    price,
    inputTokens,
    maxOutputTokens,
    rates.feeBps,
    rates.markupBps,
  );
  return Math.max(USAGE_HOLD_MICROS, worst);
}

/** The markup and OpenRouter fee a credit call is charged at now. */
export function creditRates(env: AppEnv): { markupBps: number; feeBps: number } {
  return { markupBps: markupFor(env), feeBps: openRouterFeeBps(env) };
}

const TOO_MANY_PENDING =
  'Too many replies are still running on Tangent credit. Wait for one to finish and try again.';

/** The error of a model that can't run on credit because OpenRouter lists no price for it. */
export function unpricedOnCredit(model: string): DomainError {
  return new DomainError(
    'bad_request',
    `${model} can't run on Tangent credit: it has no known price. Pick another model.`,
  );
}

/** The 402 of a call whose hold the available credit can't cover, naming what it needs. */
export function creditNeeded(holdMicros: number): PaymentRequiredError {
  // Rounded up to the cent, so the amount shown is always enough.
  const cents = Math.ceil(holdMicros / 10_000);
  return new PaymentRequiredError(
    `This reply needs about ${formatMicros(cents * 10_000)} of Tangent credit available. Add credit to keep going.`,
  );
}

/**
 * The price a credit call on `model` is held at (`creditPrice`), or a
 * thrown 400 when there is none.
 */
export async function requireCreditPrice(env: AppEnv, model: string): Promise<ModelPrice> {
  const price = await creditPrice(env, model);
  if (!price) throw unpricedOnCredit(model);
  return price;
}

/**
 * The hold of a reply on `model` before its prompt exists: its input budget
 * (`replyInputTokens`) and output cap at the model's price.
 */
export async function replyHoldMicros(
  env: AppEnv,
  model: string,
  budget: { maxInputTokens: number; maxOutputTokens: number },
): Promise<number> {
  const price = await requireCreditPrice(env, model);
  return creditHoldMicros(
    env,
    price,
    replyInputTokens(budget.maxInputTokens),
    budget.maxOutputTokens,
    creditRates(env),
  );
}

/**
 * Why a credit reservation of `holdMicros` was refused: 402 when the
 * available balance can't cover it (`creditNeeded`), else 429
 * `rate_limited` (too many calls in flight). Read after the refusal, so a
 * race can only change which.
 */
export async function creditRefusal(
  env: AppEnv,
  billingAccountId: string,
  holdMicros: number,
): Promise<DomainError> {
  const { balanceMicros, heldMicros } = await getBalance(env.DB, billingAccountId);
  if (balanceMicros - heldMicros < holdMicros) return creditNeeded(holdMicros);
  return new DomainError('rate_limited', TOO_MANY_PENDING);
}

/**
 * The early check of a reply, review or compare answer that streams from the
 * Worker (where nothing can be reserved before the 200): 402 naming what it
 * needs when the available credit can't cover `holdMicros`. A read, so the
 * meter's reservation is still what stops a race.
 */
export async function assertCreditCovers(
  env: AppEnv,
  account: AccountContext,
  holdMicros: number,
): Promise<void> {
  const { balanceMicros, heldMicros } = await getBalance(env.DB, account.billingAccountId);
  if (balanceMicros - heldMicros < holdMicros) throw creditNeeded(holdMicros);
}

/**
 * Reserves a credit reply before its nodes are written (the tree's Durable
 * Object, under its send lock): a pending row holding `holdMicros` (the
 * reply's worst case before its prompt exists, `replyHoldMicros`), taken
 * only while the balance covers it and fewer than `USAGE_MAX_PENDING` calls
 * are in flight, in one statement, so sends racing on several trees can't
 * all pass. The meter then sets the hold to the call's own worst case
 * (`repriceReservation`). Resolves the row's id; throws 402 or 429.
 */
export async function reserveCreditReply(
  env: AppEnv,
  account: AccountContext,
  target: { treeId: string; branchId: string; providerId: string; model: string },
  holdMicros: number,
): Promise<string> {
  const id = crypto.randomUUID();
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
      ...creditRates(env),
      createdAt: new Date().toISOString(),
    },
    USAGE_MAX_PENDING,
  );
  if (!reserved) throw await creditRefusal(env, account.billingAccountId, holdMicros);
  return id;
}

/** OpenRouter's credit-purchase fee in bps (`OPENROUTER_FEE_BPS`), part of the provider cost. */
export function openRouterFeeBps(env: AppEnv): number {
  return appConfig(env).billing.openRouterFeeBps;
}

/**
 * Markup on the true provider cost, in bps: `MARKUP_BPS`, else 1000 (+10%).
 * The same for every user: there are no plan discounts.
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
  if (balanceMicros - heldMicros < USAGE_HOLD_MICROS) throw new PaymentRequiredError();
  if (pendingCalls >= USAGE_MAX_PENDING) throw new DomainError('rate_limited', TOO_MANY_PENDING);
}

interface PurchaseRow {
  amount_micros: number;
  gross_micros: number;
  fee_micros: number;
  created_at: string;
}

/** The latest top-up recorded with its gross amount and processing fee. */
async function lastPurchase(env: AppEnv, accountId: string): Promise<PurchaseInfo | null> {
  const row = await env.DB.prepare(
    `SELECT amount_micros, gross_micros, fee_micros, created_at FROM credit_grants
     WHERE account_id = ? AND kind = 'purchase' AND gross_micros IS NOT NULL
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(accountId)
    .first<PurchaseRow>();
  if (!row) return null;
  return {
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
 * markup instead). The provider carries the buyer to its webhook
 * (billing/payments/apply.ts), which credits the buyer's own ledger,
 * whichever app the top-up was bought from.
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
  const session = await provider.createTopUpCheckout({
    buyer,
    amountCents,
    successUrl: checkoutReturnUrl(baseUrl, account, 'success'),
    cancelUrl: checkoutReturnUrl(baseUrl, account, 'cancel'),
  });
  if (session.customerRef) await rememberCustomer(env.DB, provider.id, userId, session.customerRef);
  return { url: session.url };
}
