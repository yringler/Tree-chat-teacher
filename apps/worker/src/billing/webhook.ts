// Stripe webhook fulfilment: the Better Auth Stripe plugin's `onEvent`
// (PLAN §2.3). The plugin itself keeps `auth_subscriptions` (the membership)
// in sync; here only the ledger moves:
//
// - checkout.session.completed (payment mode, kind=credits, paid) and
//   checkout.session.async_payment_succeeded → + amount_subtotal − fee (ref: session id).
//   A top-up is credited its pre-tax amount net of Stripe's actual processing
//   fee (tax goes to Stripe Tax and is never credited).
// - invoice.paid of the membership (the first year and every renewal), when
//   something was paid → + MEMBERSHIP_CREDIT_CENTS, a fixed gift with no fee
//   (ref: invoice id); only while the built-in provider is offered. Any other
//   subscription invoice grants nothing.
// - charge.refunded → a top-up: − pre-tax share of each refund (ref: refund id);
//   a membership invoice: − the credit it included, once (ref: its first refund id).
//
// The fee is the charge's balance transaction `fee` (in cents; its
// `fee_details` itemise card processing and any other fee Stripe books on the
// charge). When it can't be read yet (no charge or balance transaction, API
// error) the handler throws so Stripe redelivers. Every grant is idempotent on
// its Stripe ref, so redeliveries are no-ops. D1 and Stripe API errors
// propagate: the plugin answers 400 and Stripe retries.
//
// Grants go to the user's ledger, `u_<userId>` (`billingAccountIdFor`),
// whichever app the purchase came from: top-ups carry it as
// `metadata.accountId`, and a Stripe customer maps to it through
// `auth_users.stripe_customer_id`.
import { MEMBERSHIP_PLAN } from '@tangent/shared';
import type Stripe from 'stripe';
import { billingAccountIdFor } from '../auth/account.js';
import type { AppEnv } from '../env.js';
import { grantCredit, hasGrant } from './ledger.js';
import { membershipCreditCents } from './membership.js';
import { centsToMicros } from './pricing.js';
import { getStripe, membershipPriceId, userIdForCustomer } from './stripe.js';

/** The note on the credit a membership invoice includes (and that a refund of it takes back). */
export const MEMBERSHIP_CREDIT_NOTE = 'Included with membership';

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

/** The grant amounts for a pre-tax `subtotalCents` paid with `feeCents` of processing fees. */
function netOfFee(
  subtotalCents: number,
  feeCents: number,
): { amountMicros: number; grossMicros: number; feeMicros: number } {
  // The fee is charged on the tax-inclusive total, so it can (in theory) exceed the subtotal.
  const fee = Math.min(feeCents, subtotalCents);
  return {
    amountMicros: centsToMicros(subtotalCents - fee),
    grossMicros: centsToMicros(subtotalCents),
    feeMicros: centsToMicros(fee),
  };
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
  const accountId =
    session.metadata['accountId'] || (await accountForCustomer(env, session.customer));
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
  await grantCredit(env.DB, {
    accountId,
    kind: 'purchase',
    ...netOfFee(cents, feeCents),
    stripeRef: session.id,
    note: 'Credit top-up',
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
    stripeRef: invoice.id,
    note: MEMBERSHIP_CREDIT_NOTE,
  });
}

/**
 * Pre-tax share of the charge (credits never include tax); 1 when unknown.
 * `topUp`: the charge paid a credits Checkout Session.
 */
async function preTaxShare(
  stripe: Stripe,
  charge: Stripe.Charge,
): Promise<{ ratio: number; accountId: string | null; topUp: boolean }> {
  const paymentIntent = idOf(charge.payment_intent);
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
        accountId: session.metadata['accountId'] || null,
        topUp: true,
      };
    }
  }
  return { ratio: 1, accountId: null, topUp: false };
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
       WHERE stripe_ref = ? AND kind = 'subscription' LIMIT 1`,
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

  const share = await preTaxShare(stripe, charge);
  if (!share.topUp) {
    const invoiceId = await invoiceOfCharge(stripe, charge);
    if (invoiceId) {
      const grant = await invoiceGrant(env.DB, invoiceId);
      // The invoice granted no credit (no built-in provider then, or nothing paid): nothing to take back.
      if (!grant) return;
      if (grant.included) {
        // The membership's included credit is taken back once, whatever the refunded amount
        // (a fixed gift, not a share of the price). Keyed on the first refund, so a later
        // partial refund of the same charge, or a redelivery, adds nothing.
        const first = [...live].sort(
          (a, b) => a.created - b.created || a.id.localeCompare(b.id),
        )[0]!;
        if (grant.amountMicros <= 0) return;
        await grantCredit(env.DB, {
          accountId: grant.accountId,
          kind: 'refund',
          amountMicros: -grant.amountMicros,
          stripeRef: first.id,
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
  for (const refund of live) {
    const micros = Math.round(centsToMicros(refund.amount) * share.ratio);
    if (micros <= 0) continue;
    await grantCredit(env.DB, {
      accountId,
      kind: 'refund',
      amountMicros: -micros,
      stripeRef: refund.id,
      note: `Refund of ${charge.id}`,
    });
  }
}

/**
 * The Better Auth Stripe plugin's `onEvent`: credits top-ups and the credit a
 * membership invoice includes, debits refunds (idempotent). Throws on D1
 * errors so Stripe retries.
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
    default:
      return;
  }
}
