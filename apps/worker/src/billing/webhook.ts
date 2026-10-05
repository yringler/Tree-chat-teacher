// Stripe webhook fulfilment: the Better Auth Stripe plugin's `onEvent`
// (PLAN §2.3, docs/pool/PLAN.md §1.3 and §S5). The plugin itself keeps
// `auth_subscriptions` (the membership) in sync; here only the ledger moves:
//
// - checkout.session.completed (payment mode, kind=credits, paid) and
//   checkout.session.async_payment_succeeded → a purchase, credited by
//   `fulfilPurchase` (billing/purchases.ts) to its `metadata.target`: absent
//   or `personal` → the buyer's ledger, + amount_subtotal − fee; `pool` → the
//   community pool, + amount_subtotal / (1 + POOL_MARGIN_BPS) (ref: session id).
//   Tax goes to Stripe Tax and is never credited.
// - invoice.paid of the membership (the first year and every renewal), when
//   something was paid → + MEMBERSHIP_CREDIT_CENTS, a fixed gift with no fee
//   (ref: invoice id); only while the built-in provider is offered. Any other
//   subscription invoice grants nothing.
// - charge.refunded → a personal top-up: − pre-tax share of each refund; a
//   pool purchase: − the credit-equivalent of each refund, clamped to what the
//   pool has available (PoolBank.debit; ref: refund id); a membership invoice:
//   − the credit it included, once (ref: its first refund id).
// - charge.dispute.funds_withdrawn → a top-up or pool purchase is debited like
//   a refund of the disputed amount (ref: dispute id);
//   charge.dispute.funds_reinstated (the dispute was won) credits back what
//   was debited (ref: `<dispute id>:reinstated`); charge.dispute.closed as
//   `lost` suspends the buyer's community pool access.
//
// Idempotency is on the Stripe object, not the event: every grant is keyed on
// its Stripe ref, so redeliveries, and the same session arriving through both
// checkout events, credit once.
//
// The fee is the charge's balance transaction `fee` (in cents; its
// `fee_details` itemise card processing and any other fee Stripe books on the
// charge). When it can't be read yet (no charge or balance transaction, API
// error) the handler throws so Stripe redelivers. D1 and Stripe API errors
// propagate: the plugin answers 400 and Stripe retries.
//
// Personal grants go to the user's ledger, `u_<userId>` (`billingAccountIdFor`),
// whichever app the purchase came from: purchases carry it as
// `metadata.accountId` (and the buyer as `metadata.userId`), and a Stripe
// customer maps to it through `auth_users.stripe_customer_id`.
import { MEMBERSHIP_PLAN, PURCHASE_TARGETS, type PurchaseTarget } from '@tangent/shared';
import type Stripe from 'stripe';
import { billingAccountIdFor, userIdOfAccount } from '../auth/account.js';
import { appConfig } from '../config.js';
import type { AppEnv } from '../env.js';
import { identitySuspensionStatement } from '../pool/identity.js';
import { poolBank } from '../pool/ids.js';
import { creditEquivalentMicros, poolCreditMicros } from '../pool/pricing.js';
import { grantByRef, grantCredit, hasGrant } from './ledger.js';
import { membershipCreditCents } from './membership.js';
import { centsToMicros } from './pricing.js';
import { fulfilPurchase } from './purchases.js';
import { getStripe, membershipPriceId, userIdForCustomer } from './stripe.js';

/** The note on the credit a membership invoice includes (and that a refund of it takes back). */
export const MEMBERSHIP_CREDIT_NOTE = 'Included with membership';

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

async function accountForCustomer(
  env: AppEnv,
  customer: string | { id: string } | null,
): Promise<string | null> {
  const customerId = idOf(customer);
  if (!customerId) return null;
  const userId = await userIdForCustomer(env.DB, customerId);
  return userId ? billingAccountIdFor(userId) : null;
}

/** Stripe's fee on a charge, in US cents, from its (expanded) balance transaction. */
function chargeFeeCents(charge: string | Stripe.Charge | null | undefined, ref: string): number {
  if (!charge || typeof charge === 'string')
    throw new Error(`No charge yet for ${ref}; the fee is unknown, retry later`);
  const bt = charge.balance_transaction;
  if (!bt || typeof bt === 'string')
    throw new Error(`No balance transaction yet for ${ref}; the fee is unknown, retry later`);
  if (!Number.isInteger(bt.fee) || bt.fee < 0)
    throw new Error(`Unexpected fee on balance transaction ${bt.id}`);
  if (bt.currency === 'usd') return bt.fee;
  // Settled in another currency: charge amount × exchange_rate = settled amount.
  if (!bt.exchange_rate || bt.exchange_rate <= 0)
    throw new Error(`No exchange rate on balance transaction ${bt.id} (${bt.currency})`);
  return Math.ceil(bt.fee / bt.exchange_rate);
}

/** Fee of a PaymentIntent's latest (successful) charge, in cents. */
async function paymentIntentFee(
  stripe: Stripe,
  paymentIntent: string,
  ref: string,
): Promise<{ feeCents: number; chargedCents: number }> {
  const intent = await stripe.paymentIntents.retrieve(paymentIntent, {
    expand: ['latest_charge.balance_transaction'],
  });
  const charge = intent.latest_charge;
  return {
    feeCents: chargeFeeCents(charge, ref),
    chargedCents: typeof charge === 'object' && charge ? charge.amount : intent.amount_received,
  };
}

/** A credits checkout's `metadata.target`: absent → personal (sessions from before the pool); null when unknown. */
function purchaseTargetOf(metadata: Stripe.Metadata | null | undefined): PurchaseTarget | null {
  const raw = metadata?.['target'];
  if (!raw) return 'personal';
  return (PURCHASE_TARGETS as readonly string[]).includes(raw) ? (raw as PurchaseTarget) : null;
}

/**
 * The buyer of a credits checkout: `metadata.userId`, else the user behind
 * its personal ledger (`u_<userId>`), else its Stripe customer's user.
 */
async function buyerOf(
  env: AppEnv,
  metadata: Stripe.Metadata | null | undefined,
  customer: string | { id: string } | null | undefined,
): Promise<string | null> {
  const fromMetadata = metadata?.['userId'];
  if (fromMetadata) return fromMetadata;
  const accountId = metadata?.['accountId'];
  const fromAccount = accountId ? userIdOfAccount(accountId) : null;
  if (fromAccount) return fromAccount;
  const customerId = idOf(customer);
  return customerId ? userIdForCustomer(env.DB, customerId) : null;
}

async function creditCheckout(env: AppEnv, session: Stripe.Checkout.Session): Promise<void> {
  if (session.mode !== 'payment' || session.metadata?.['kind'] !== 'credits') return;
  if (session.payment_status !== 'paid') return; // async methods: wait for async_payment_succeeded
  if (session.currency && session.currency !== 'usd') {
    console.error(
      'Ignoring a credits checkout in an unexpected currency',
      session.id,
      session.currency,
    );
    return;
  }
  const cents = session.amount_subtotal ?? 0;
  if (cents <= 0) return;
  const target = purchaseTargetOf(session.metadata);
  if (!target) {
    console.error('Credits checkout for an unknown target; not credited', session.id);
    return;
  }
  const accountId =
    session.metadata['accountId'] ||
    (target === 'pool'
      ? appConfig(env).pool.accountId
      : await accountForCustomer(env, session.customer));
  if (!accountId) {
    console.error('Credits checkout without an account; not credited', session.id);
    return;
  }
  if (await hasGrant(env.DB, session.id)) return; // redelivery: skip the fee lookup
  // Fee before the grant: if it can't be read yet, throw and let Stripe redeliver.
  const stripe = getStripe(env);
  if (!stripe) throw new Error('Stripe is not configured');
  const paymentIntent = idOf(session.payment_intent);
  if (!paymentIntent) throw new Error(`Paid credits checkout ${session.id} has no PaymentIntent`);
  const { feeCents } = await paymentIntentFee(stripe, paymentIntent, session.id);
  await fulfilPurchase(env, {
    target,
    userId: await buyerOf(env, session.metadata, session.customer),
    accountId,
    grossCents: cents,
    processorFeeCents: feeCents,
    ref: session.id,
  });
}

/**
 * True when a subscription invoice is the membership's: one of its lines is
 * the membership price, or its subscription is the plugin's `membership` plan
 * (found by the plugin's own row id in the subscription metadata, or by the
 * Stripe subscription id). The second test keeps renewals of an older price
 * recognised after the operator changes STRIPE_MEMBERSHIP_PRICE_ID.
 */
async function isMembershipInvoice(env: AppEnv, invoice: Stripe.Invoice): Promise<boolean> {
  const priceId = membershipPriceId(env);
  if (priceId && invoice.lines?.data.some((l) => idOf(l.pricing?.price_details?.price) === priceId))
    return true;
  const details = invoice.parent?.subscription_details;
  const pluginId = details?.metadata?.['subscriptionId'] ?? null;
  const stripeId = idOf(details?.subscription);
  if (!pluginId && !stripeId) return false;
  const row = await env.DB.prepare(
    `SELECT 1 AS one FROM auth_subscriptions
     WHERE plan = ?1 AND (id = ?2 OR stripe_subscription_id = ?3) LIMIT 1`,
  )
    .bind(MEMBERSHIP_PLAN, pluginId, stripeId)
    .first<{ one: number }>();
  return row !== null;
}

/**
 * A paid membership invoice (the first year or a renewal) includes
 * MEMBERSHIP_CREDIT_CENTS of credit: a fixed gift, not a purchase, so no
 * gross amount or fee. Nothing when the built-in provider isn't offered (the
 * amount is then 0) or nothing was paid (a trial or a 100% discount).
 */
async function creditMembershipInvoice(env: AppEnv, invoice: Stripe.Invoice): Promise<void> {
  // One-off invoices (e.g. Checkout's invoice_creation receipts) have no subscription parent.
  if (invoice.parent?.type !== 'subscription_details' || !invoice.id) return;
  if (!(invoice.total > 0)) return;
  const cents = membershipCreditCents(env);
  if (cents <= 0) return;
  if (!(await isMembershipInvoice(env, invoice))) return;
  const accountId = await accountForCustomer(env, invoice.customer);
  // The plugin stores the customer id before Checkout opens, so this is a race at worst: retry.
  if (!accountId) throw new Error(`No user for Stripe customer of invoice ${invoice.id}`);
  await grantCredit(env.DB, {
    accountId,
    kind: 'subscription',
    amountMicros: centsToMicros(cents),
    grossMicros: null,
    feeMicros: 0,
    providerRef: invoice.id,
    note: MEMBERSHIP_CREDIT_NOTE,
  });
}

/** What a refund or dispute needs to know about the credits checkout a payment paid. */
interface PurchaseShare {
  /** Pre-tax share of the payment (credits never include tax); 1 when unknown. */
  ratio: number;
  /** The payment paid a credits Checkout Session. */
  topUp: boolean;
  /** The ledger it credited (`metadata.accountId`). */
  accountId: string | null;
  /** Null for a target this webhook does not know: never credited, so never debited. */
  target: PurchaseTarget | null;
  /** The buyer. */
  userId: string | null;
  /** The Checkout Session id: the purchase grant's ref. */
  sessionId: string | null;
}

/** The credits checkout `paymentIntent` paid, if any (the fields above). */
async function purchaseShare(
  env: AppEnv,
  stripe: Stripe,
  paymentIntent: string | null,
): Promise<PurchaseShare> {
  if (paymentIntent) {
    const sessions = await stripe.checkout.sessions.list({
      payment_intent: paymentIntent,
      limit: 1,
    });
    const session = sessions.data[0];
    if (session && session.metadata?.['kind'] === 'credits') {
      const total = session.amount_total ?? 0;
      const subtotal = session.amount_subtotal ?? 0;
      return {
        ratio: total > 0 ? Math.min(1, subtotal / total) : 1,
        topUp: true,
        accountId: session.metadata['accountId'] || null,
        target: purchaseTargetOf(session.metadata),
        userId: await buyerOf(env, session.metadata, session.customer),
        sessionId: session.id,
      };
    }
  }
  return {
    ratio: 1,
    topUp: false,
    accountId: null,
    target: 'personal',
    userId: null,
    sessionId: null,
  };
}

/** The invoice a charge paid (through its PaymentIntent), if any. */
async function invoiceOfCharge(stripe: Stripe, charge: Stripe.Charge): Promise<string | null> {
  const paymentIntent = idOf(charge.payment_intent);
  if (!paymentIntent) return null;
  const payments = await stripe.invoicePayments.list({
    payment: { type: 'payment_intent', payment_intent: paymentIntent },
    limit: 1,
  });
  return idOf(payments.data[0]?.invoice);
}

/** The credit an invoice granted: the membership's included credit, or (older ledgers) a monthly plan's. */
async function invoiceGrant(
  db: D1Database,
  invoiceId: string,
): Promise<{ accountId: string; amountMicros: number; included: boolean } | null> {
  const row = await db
    .prepare(
      `SELECT account_id, amount_micros, gross_micros FROM credit_grants
       WHERE provider_ref = ? AND kind = 'subscription' LIMIT 1`,
    )
    .bind(invoiceId)
    .first<{ account_id: string; amount_micros: number; gross_micros: number | null }>();
  if (!row) return null;
  return {
    accountId: row.account_id,
    amountMicros: row.amount_micros,
    included: row.gross_micros === null,
  };
}

/**
 * Debits the pre-tax share of each refund in full, although the purchase was
 * credited net of Stripe's fee: Stripe keeps its processing fee on a refund,
 * so the operator is out that fee either way and the refund passes it on.
 */
async function debitRefunds(env: AppEnv, charge: Stripe.Charge): Promise<void> {
  if (charge.currency !== 'usd') return;
  const stripe = getStripe(env);
  if (!stripe) throw new Error('Stripe is not configured');
  // Since 2022-11-15 charges no longer embed their refunds; list them when absent.
  const refunds = charge.refunds?.data.length
    ? charge.refunds.data
    : (await stripe.refunds.list({ charge: charge.id, limit: 100 })).data;
  const live = refunds.filter((r) => r.status === 'succeeded' || r.status === 'pending');
  if (live.length === 0) return;

  const share = await purchaseShare(env, stripe, idOf(charge.payment_intent));
  if (share.topUp && !share.target) {
    console.error('Refunded checkout for an unknown target; not debited', charge.id);
    return;
  }
  if (share.topUp && share.target === 'pool') {
    for (const refund of live)
      await debitPoolPurchase(env, share, {
        refId: refund.id,
        refundedCents: refund.amount,
        note: `Refund of ${charge.id}`,
      });
    return;
  }
  if (!share.topUp) {
    const invoiceId = await invoiceOfCharge(stripe, charge);
    if (invoiceId) {
      const grant = await invoiceGrant(env.DB, invoiceId);
      // The invoice granted no credit (no built-in provider then, or nothing paid): nothing to take back.
      if (!grant) return;
      if (grant.included) {
        // The membership's included credit is taken back once, whatever the refunded amount
        // (a fixed gift, not a share of the price). Keyed on the charge's first refund, failed
        // ones included so the key never moves, so a later partial refund of the same charge,
        // a retry after a failed refund, or a redelivery adds nothing.
        const first = [...refunds].sort(
          (a, b) => a.created - b.created || a.id.localeCompare(b.id),
        )[0]!;
        if (grant.amountMicros <= 0) return;
        await grantCredit(env.DB, {
          accountId: grant.accountId,
          kind: 'refund',
          amountMicros: -grant.amountMicros,
          providerRef: first.id,
          note: `Refund of membership invoice ${invoiceId}`,
        });
        return;
      }
      // A monthly-plan invoice from before the membership: debited like any other charge below.
    }
  }
  const accountId = share.accountId ?? (await accountForCustomer(env, charge.customer));
  if (!accountId) {
    console.error('Refunded charge without a known account; not debited', charge.id);
    return;
  }
  const userId = share.userId ?? userIdOfAccount(accountId);
  for (const refund of live) {
    const micros = Math.round(centsToMicros(refund.amount) * share.ratio);
    if (micros <= 0) continue;
    await grantCredit(env.DB, {
      accountId,
      kind: 'refund',
      amountMicros: -micros,
      grossMicros: -micros,
      userId,
      providerRef: refund.id,
      note: `Refund of ${charge.id}`,
    });
  }
}

/**
 * Debits the pool for `refundedCents` (tax included) of a pool purchase being
 * refunded or disputed: the credit-equivalent of its pre-tax share (what that
 * part of the purchase granted after the margin), clamped to what the pool
 * has available. The row is always written (PoolBank.debit), so a
 * redelivery is a no-op.
 */
async function debitPoolPurchase(
  env: AppEnv,
  share: PurchaseShare,
  debit: { refId: string; refundedCents: number; note: string },
): Promise<void> {
  const refundedGross = Math.round(centsToMicros(debit.refundedCents) * share.ratio);
  if (refundedGross <= 0) return;
  const grant = share.sessionId ? await grantByRef(env.DB, share.sessionId) : null;
  const config = appConfig(env);
  const requested =
    grant && grant.gross_micros !== null && grant.gross_micros > 0
      ? creditEquivalentMicros(refundedGross, {
          amountMicros: grant.amount_micros,
          grossMicros: grant.gross_micros,
        })
      : // The purchase was never credited (or is unknown): what it would have granted.
        poolCreditMicros(refundedGross, config.pool.marginBps);
  const poolId = grant?.account_id ?? share.accountId ?? config.pool.accountId;
  await poolBank(env, poolId).debit({
    poolId,
    refId: debit.refId,
    requestedMicros: requested,
    kind: 'refund',
    userId: grant?.user_id ?? share.userId,
    grossMicros: -refundedGross,
    note: debit.note,
  });
}

/** The PaymentIntent a dispute's charge was paid by. */
async function disputedPaymentIntent(
  stripe: Stripe,
  dispute: Stripe.Dispute,
): Promise<string | null> {
  const direct = idOf(dispute.payment_intent);
  if (direct) return direct;
  const chargeId = idOf(dispute.charge);
  if (!chargeId) return null;
  return idOf((await stripe.charges.retrieve(chargeId)).payment_intent);
}

/**
 * What debitDispute does for a disputed top-up: debit the pool, debit a
 * personal account, or skip (no row is written). reinstateDispute reads it
 * too, to tell a withdrawal that was never debited from one yet to arrive.
 */
function disputeDebit(
  share: PurchaseShare,
  dispute: Stripe.Dispute,
):
  | { skip: 'unknown_target' | 'no_account' | 'nothing'; target?: undefined }
  | { skip?: undefined; target: 'pool' }
  | { skip?: undefined; target: 'personal'; accountId: string; micros: number } {
  if (!share.target) return { skip: 'unknown_target' };
  const micros = Math.round(centsToMicros(dispute.amount) * share.ratio);
  // Same rounding as debitPoolPurchase, which writes no row for nothing.
  if (micros <= 0) return { skip: 'nothing' };
  if (share.target === 'pool') return { target: 'pool' };
  const accountId = share.accountId ?? (share.userId ? billingAccountIdFor(share.userId) : null);
  if (!accountId) return { skip: 'no_account' };
  return { target: 'personal', accountId, micros };
}

/**
 * A dispute's funds were withdrawn: the disputed purchase is debited like a
 * refund of the disputed amount, keyed on the dispute id. A personal top-up
 * is debited in full (it may go negative, as for refunds); a pool purchase
 * through PoolBank.debit (clamped). Disputes of anything else (a membership
 * invoice) are left to the operator.
 */
async function debitDispute(env: AppEnv, dispute: Stripe.Dispute): Promise<void> {
  if (dispute.currency !== 'usd') return;
  const stripe = getStripe(env);
  if (!stripe) throw new Error('Stripe is not configured');
  const share = await purchaseShare(env, stripe, await disputedPaymentIntent(stripe, dispute));
  const note = `Dispute of ${idOf(dispute.charge) ?? 'a charge'}`;
  if (!share.topUp) {
    console.warn(JSON.stringify({ event: 'dispute_not_debited', disputeId: dispute.id }));
    return;
  }
  const plan = disputeDebit(share, dispute);
  if (plan.skip === 'unknown_target') {
    console.error('Disputed checkout for an unknown target; not debited', dispute.id);
    return;
  }
  if (plan.skip === 'no_account') {
    console.error('Disputed top-up without a known account; not debited', dispute.id);
    return;
  }
  if (plan.skip) return;
  if (plan.target === 'pool') {
    await debitPoolPurchase(env, share, {
      refId: dispute.id,
      refundedCents: dispute.amount,
      note,
    });
    return;
  }
  const { accountId, micros } = plan;
  await grantCredit(env.DB, {
    accountId,
    kind: 'refund',
    amountMicros: -micros,
    grossMicros: -micros,
    userId: share.userId ?? userIdOfAccount(accountId),
    providerRef: dispute.id,
    note,
  });
}

/**
 * The dispute was won and its funds reinstated: credits back exactly what the
 * dispute debited (for the pool, the clamped amount), once.
 */
async function reinstateDispute(env: AppEnv, dispute: Stripe.Dispute): Promise<void> {
  const debited = await grantByRef(env.DB, dispute.id);
  if (!debited) {
    // Not debited (not a purchase, or another currency); or the withdrawal is yet to arrive.
    const stripe = getStripe(env);
    if (!stripe) throw new Error('Stripe is not configured');
    const share = await purchaseShare(env, stripe, await disputedPaymentIntent(stripe, dispute));
    // Only a withdrawal debitDispute would have written a row for is worth waiting on.
    if (share.topUp && dispute.currency === 'usd' && !disputeDebit(share, dispute).skip)
      throw new Error(`Dispute ${dispute.id} reinstated before it was debited; retry later`);
    return;
  }
  await grantCredit(env.DB, {
    accountId: debited.account_id,
    kind: 'refund',
    amountMicros: -debited.amount_micros,
    grossMicros: debited.gross_micros === null ? null : -debited.gross_micros,
    userId: debited.user_id,
    providerRef: `${dispute.id}:reinstated`,
    note: `Dispute ${dispute.id} won`,
  });
}

/**
 * A dispute of a credit purchase was lost: its buyer's community pool access
 * is suspended (on the account and its pool identity, as an admin's
 * suspension; an admin can lift it).
 */
async function suspendForLostDispute(env: AppEnv, dispute: Stripe.Dispute): Promise<void> {
  if (dispute.status !== 'lost') return;
  const stripe = getStripe(env);
  if (!stripe) throw new Error('Stripe is not configured');
  const share = await purchaseShare(env, stripe, await disputedPaymentIntent(stripe, dispute));
  const userId = share.userId ?? (share.accountId ? userIdOfAccount(share.accountId) : null);
  if (!share.topUp || !userId) return;
  const db = env.DB;
  await db.batch([
    db.prepare('UPDATE auth_users SET pool_suspended = 1 WHERE id = ?').bind(userId),
    identitySuspensionStatement(db, userId, true),
  ]);
  console.warn(
    JSON.stringify({ event: 'pool_suspended_dispute_lost', userId, disputeId: dispute.id }),
  );
}

/**
 * The Better Auth Stripe plugin's `onEvent`: credits purchases (personal or
 * pool) and the credit a membership invoice includes, debits refunds and
 * disputes (idempotent). Throws on D1 errors so Stripe retries.
 */
export async function handleStripeEvent(env: AppEnv, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return creditCheckout(env, event.data.object);
    case 'invoice.paid':
      return creditMembershipInvoice(env, event.data.object);
    case 'charge.refunded':
      return debitRefunds(env, event.data.object);
    case 'charge.dispute.funds_withdrawn':
      return debitDispute(env, event.data.object);
    case 'charge.dispute.funds_reinstated':
      return reinstateDispute(env, event.data.object);
    case 'charge.dispute.closed':
      return suspendForLostDispute(env, event.data.object);
    default:
      return;
  }
}
