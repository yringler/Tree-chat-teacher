// Stripe webhook fulfilment: the Better Auth Stripe plugin's `onEvent`
// (PLAN §2.3). Credits the pre-tax amount net of Stripe's actual processing
// fee (tax goes to Stripe Tax and is never credited):
//
// - checkout.session.completed (payment mode, kind=credits, paid) and
//   checkout.session.async_payment_succeeded → + amount_subtotal − fee (ref: session id)
// - invoice.paid for a subscription (any billing reason: create, cycle, a
//   prorated update, threshold) with a positive subtotal → + subtotal − fee (ref: invoice id)
// - charge.refunded → − pre-tax share of each refund (ref: refund id)
//
// The fee is the charge's balance transaction `fee` (in cents; its
// `fee_details` itemise card processing and any other fee Stripe books on the
// charge). When it can't be read yet (no charge or balance transaction, API
// error) the handler throws so Stripe redelivers. Every grant is idempotent on
// its Stripe ref, so redeliveries are no-ops. D1 and Stripe API errors
// propagate: the plugin answers 400 and Stripe retries.
//
// Grants go to the user's ledger, `u_<userId>`, whichever app the purchase
// came from: top-ups carry it as `metadata.accountId`, and a Stripe customer
// maps to it through `auth_users.stripe_customer_id`.
import type Stripe from 'stripe';
import type { AppEnv } from '../env.js';
import { grantCredit, hasGrant } from './ledger.js';
import { centsToMicros } from './pricing.js';
import { accountIdForUser, getStripe, userIdForCustomer } from './stripe.js';

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
  return userId ? accountIdForUser(userId) : null;
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

/** Fee of a charge with no PaymentIntent, in cents. */
async function chargeFee(
  stripe: Stripe,
  chargeId: string,
  ref: string,
): Promise<{ feeCents: number; chargedCents: number }> {
  const charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
  return { feeCents: chargeFeeCents(charge, ref), chargedCents: charge.amount };
}

/**
 * Stripe's processing fee for a paid subscription invoice, in cents: the sum
 * over its paid invoice payments (dahlia: `invoice_payments`, each naming a
 * PaymentIntent or a bare charge). A payment that also paid other invoices
 * contributes its fee pro rata. Zero when nothing was charged (paid entirely
 * from the customer's credit balance).
 */
async function invoiceFeeCents(
  stripe: Stripe,
  invoiceId: string,
  amountPaidCents: number,
): Promise<number> {
  if (!(amountPaidCents > 0)) return 0;
  const payments = await stripe.invoicePayments.list({
    invoice: invoiceId,
    status: 'paid',
    limit: 100,
  });
  let fee = 0;
  let charged = 0;
  for (const p of payments.data) {
    const paid = p.amount_paid ?? 0;
    if (paid <= 0) continue;
    const intent = idOf(p.payment.payment_intent);
    const charge = idOf(p.payment.charge);
    let r: { feeCents: number; chargedCents: number };
    if (intent) r = await paymentIntentFee(stripe, intent, invoiceId);
    else if (charge) r = await chargeFee(stripe, charge, invoiceId);
    else continue; // a payment record: paid outside Stripe, no Stripe fee
    fee += r.chargedCents > paid ? Math.ceil((r.feeCents * paid) / r.chargedCents) : r.feeCents;
    charged += paid;
  }
  if (charged <= 0)
    throw new Error(`No paid Stripe payment found for invoice ${invoiceId}; retry later`);
  return fee;
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

async function creditInvoice(env: AppEnv, invoice: Stripe.Invoice): Promise<void> {
  // One-off invoices (e.g. Checkout's invoice_creation receipts) have no subscription parent.
  // Every paid subscription invoice counts, whatever its billing_reason: a customer who
  // pays a prorated invoice (e.g. a plan switch in the Customer Portal) gets that credit.
  if (invoice.parent?.type !== 'subscription_details') return;
  if (invoice.currency && invoice.currency !== 'usd') {
    console.error(
      'Ignoring a subscription invoice in an unexpected currency',
      invoice.id,
      invoice.currency,
    );
    return;
  }
  if (invoice.subtotal <= 0 || !invoice.id) return;
  const accountId = await accountForCustomer(env, invoice.customer);
  // The plugin stores the customer id before Checkout opens, so this is a race at worst: retry.
  if (!accountId) throw new Error(`No user for Stripe customer of invoice ${invoice.id}`);
  if (await hasGrant(env.DB, invoice.id)) return; // redelivery: skip the fee lookup
  const stripe = getStripe(env);
  if (!stripe) throw new Error('Stripe is not configured');
  const feeCents = await invoiceFeeCents(stripe, invoice.id, invoice.amount_paid);
  await grantCredit(env.DB, {
    accountId,
    kind: 'subscription',
    ...netOfFee(invoice.subtotal, feeCents),
    stripeRef: invoice.id,
    note: 'Monthly plan credit',
  });
}

/** Pre-tax share of the charge (credits never include tax); 1 when unknown. */
async function preTaxShare(
  stripe: Stripe,
  charge: Stripe.Charge,
): Promise<{ ratio: number; accountId: string | null }> {
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
      };
    }
  }
  return { ratio: 1, accountId: null };
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
 * The Better Auth Stripe plugin's `onEvent`: credits top-ups and subscription
 * invoices, debits refunds (idempotent). Throws on D1 errors so Stripe retries.
 */
export async function handleStripeEvent(env: AppEnv, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return creditCheckout(env, event.data.object);
    case 'invoice.paid':
      return creditInvoice(env, event.data.object);
    case 'charge.refunded':
      return debitRefunds(env, event.data.object);
    default:
      return;
  }
}
