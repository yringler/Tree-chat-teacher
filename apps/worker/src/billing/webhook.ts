// Stripe webhook fulfilment: the Better Auth Stripe plugin's `onEvent`
// (PLAN §2.3). Credits pre-tax amounts only; Stripe Tax handles the rest.
//
// - checkout.session.completed (payment mode, kind=credits, paid) and
//   checkout.session.async_payment_succeeded → + amount_subtotal (ref: session id)
// - invoice.paid for a subscription (create/cycle) → + subtotal (ref: invoice id)
// - charge.refunded → − pre-tax share of each refund (ref: refund id)
//
// Every grant is idempotent on its Stripe ref, so redeliveries are no-ops. D1
// and Stripe API errors propagate: the plugin answers 400 and Stripe retries.
import type Stripe from 'stripe';
import type { AppEnv } from '../env.js';
import { grantCredit } from './ledger.js';
import { centsToMicros } from './pricing.js';
import { accountIdForUser, getStripe, userIdForCustomer } from './stripe.js';

const SUBSCRIPTION_CREDIT_REASONS: ReadonlySet<string> = new Set([
  'subscription_create',
  'subscription_cycle',
]);

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
  return userId ? accountIdForUser(userId) : null;
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
  await grantCredit(env.DB, {
    accountId,
    kind: 'purchase',
    amountMicros: centsToMicros(cents),
    stripeRef: session.id,
    note: 'Credit top-up',
  });
}

async function creditInvoice(env: AppEnv, invoice: Stripe.Invoice): Promise<void> {
  // One-off invoices (e.g. Checkout's invoice_creation receipts) have no subscription parent.
  if (invoice.parent?.type !== 'subscription_details') return;
  if (!invoice.billing_reason || !SUBSCRIPTION_CREDIT_REASONS.has(invoice.billing_reason)) return;
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
  await grantCredit(env.DB, {
    accountId,
    kind: 'subscription',
    amountMicros: centsToMicros(invoice.subtotal),
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
