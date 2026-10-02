import { env as rawEnv } from 'cloudflare:workers';
import type Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBalance } from '../src/billing/ledger.js';
import { handleStripeEvent } from '../src/billing/webhook.js';
import type { AppEnv } from '../src/env.js';
import {
  envWithFailingDb,
  grantDetailsFor,
  grantsFor,
  insertUser,
  stripeCalls,
  stripeFixtures,
  uniq,
} from './mocks/billing-helpers.js';
import { defaultFeeDetails, type MockPaymentIntent } from './mocks/stripe.js';

const env = rawEnv as unknown as AppEnv;

let eventSeq = 0;
function event(type: string, object: Record<string, unknown>): Stripe.Event {
  return {
    id: `evt_test_${++eventSeq}`,
    object: 'event',
    api_version: '2026-08-26.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

/** The mock's default fee: 2.9% + 30¢ card processing and the 0.5% Stripe Tax fee. */
function defaultFee(totalCents: number): number {
  const { stripe, tax } = defaultFeeDetails(totalCents);
  return stripe + tax;
}

/**
 * A paid credits Checkout Session; its PaymentIntent is registered with the
 * Stripe mock (amount = `amount_total`) unless `payment` is null.
 */
async function checkoutSession(
  overrides: Record<string, unknown> = {},
  payment: Partial<MockPaymentIntent> | null = {},
): Promise<Record<string, unknown>> {
  const session: Record<string, unknown> = {
    id: uniq('cs_test'),
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    status: 'complete',
    currency: 'usd',
    amount_subtotal: 1000,
    amount_total: 1087, // tax on top: never credited
    customer: uniq('cus'),
    subscription: null,
    payment_intent: uniq('pi_test'),
    metadata: { kind: 'credits', accountId: uniq('u_acct'), amountCents: '1000' },
    ...overrides,
  };
  if (payment) {
    await stripeFixtures({
      paymentIntents: [
        {
          id: session['payment_intent'] as string,
          amount: session['amount_total'] as number,
          ...payment,
        },
      ],
    });
  }
  return session;
}

/**
 * A paid subscription invoice (tax on top of the subtotal); one invoice
 * payment through a registered PaymentIntent unless `payment` is null.
 */
async function invoice(
  customer: string,
  overrides: Record<string, unknown> = {},
  payment: Partial<MockPaymentIntent> | null = {},
): Promise<Record<string, unknown>> {
  const subtotal = (overrides['subtotal'] as number | undefined) ?? 2000;
  const total = Math.max(0, Math.round(subtotal * 1.085));
  const inv: Record<string, unknown> = {
    id: uniq('in_test'),
    object: 'invoice',
    customer,
    currency: 'usd',
    billing_reason: 'subscription_cycle',
    subtotal,
    total,
    amount_paid: total,
    parent: { type: 'subscription_details', subscription_details: { subscription: uniq('sub') } },
    ...overrides,
  };
  if (payment && (inv['amount_paid'] as number) > 0) {
    const pi = uniq('pi_inv');
    await stripeFixtures({
      paymentIntents: [{ id: pi, amount: inv['amount_paid'] as number, ...payment }],
      invoicePayments: [
        {
          id: uniq('inpay'),
          object: 'invoice_payment',
          invoice: inv['id'],
          status: 'paid',
          amount_paid: inv['amount_paid'],
          amount_requested: inv['amount_paid'],
          is_default: true,
          payment: { type: 'payment_intent', payment_intent: pi },
        },
      ],
    });
  }
  return inv;
}

/** micro-USD credited for `subtotal` cents paid with `fee` cents of fees. */
const net = (subtotal: number, fee: number) => (subtotal - fee) * 10_000;

async function userWithCustomer(): Promise<{
  userId: string;
  customer: string;
  accountId: string;
}> {
  const userId = uniq('user');
  const customer = uniq('cus');
  await insertUser(env, { id: userId, stripeCustomerId: customer });
  return { userId, customer, accountId: `u_${userId}` };
}

const balance = async (accountId: string) => (await getBalance(env.DB, accountId)).balanceMicros;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Stripe webhook fulfilment', () => {
  it("credits a $5 top-up its pre-tax subtotal minus Stripe's actual fee", async () => {
    // $5.00 + $0.40 tax = $5.40 charged; Stripe's fee 46¢ (processing + Stripe Tax).
    const session = await checkoutSession(
      {
        amount_subtotal: 500,
        amount_total: 540,
        metadata: { kind: 'credits', accountId: uniq('u_acct') },
      },
      { fee: 46 },
    );
    const accountId = (session['metadata'] as Record<string, string>)['accountId']!;
    await handleStripeEvent(env, event('checkout.session.completed', session));
    // 500 − 46 = 454¢: not 500 (gross), not 460 (fee taken off the taxed total).
    expect(await grantDetailsFor(env, accountId)).toEqual([
      {
        kind: 'purchase',
        amount_micros: 4_540_000,
        gross_micros: 5_000_000,
        fee_micros: 460_000,
        stripe_ref: session['id'],
      },
    ]);
    expect(await balance(accountId)).toBe(4_540_000);
    const lookups = await stripeCalls(`/v1/payment_intents/${String(session['payment_intent'])}`);
    expect(lookups).toHaveLength(1);
    expect(Object.values(lookups[0]!.query)).toContain('latest_charge.balance_transaction');
  });

  it('credits a paid top-up once per session, net of the default card + tax fees', async () => {
    const session = await checkoutSession();
    const accountId = (session['metadata'] as Record<string, string>)['accountId']!;
    await handleStripeEvent(env, event('checkout.session.completed', session));
    await handleStripeEvent(env, event('checkout.session.completed', session));
    await handleStripeEvent(
      env,
      event('checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' }),
    );
    const fee = defaultFee(1087); // 2.9% + 30¢ + 0.5% of the taxed total = 67¢
    expect(fee).toBe(67);
    expect(await grantsFor(env, accountId)).toEqual([
      { kind: 'purchase', amount_micros: net(1000, fee), stripe_ref: session['id'] },
    ]);
    expect(await balance(accountId)).toBe(net(1000, fee));
    // Redeliveries are answered from the ledger, without another fee lookup.
    const lookups = await stripeCalls(`/v1/payment_intents/${String(session['payment_intent'])}`);
    expect(lookups).toHaveLength(1);
  });

  it('throws (so Stripe retries) while the fee is unknown, then credits on redelivery', async () => {
    const noTxn = await checkoutSession({}, { balanceTransaction: false });
    const accountId = (noTxn['metadata'] as Record<string, string>)['accountId']!;
    await expect(
      handleStripeEvent(env, event('checkout.session.completed', noTxn)),
    ).rejects.toThrow(/balance transaction/);
    expect(await grantsFor(env, accountId)).toEqual([]);

    const noCharge = await checkoutSession({}, { latestCharge: false });
    await expect(
      handleStripeEvent(env, event('checkout.session.completed', noCharge)),
    ).rejects.toThrow(/No charge/);

    const unknown = await checkoutSession({}, null); // the API answers 404
    await expect(
      handleStripeEvent(env, event('checkout.session.completed', unknown)),
    ).rejects.toThrow();
    const noIntent = await checkoutSession({ payment_intent: null }, null);
    await expect(
      handleStripeEvent(env, event('checkout.session.completed', noIntent)),
    ).rejects.toThrow(/PaymentIntent/);

    // The charge settles: Stripe's next delivery credits it.
    await stripeFixtures({
      paymentIntents: [{ id: noTxn['payment_intent'] as string, amount: 1087, fee: 60 }],
    });
    await handleStripeEvent(env, event('checkout.session.completed', noTxn));
    expect(await balance(accountId)).toBe(net(1000, 60));
  });

  it('waits for async payment methods to succeed', async () => {
    const session = await checkoutSession({ payment_status: 'unpaid' });
    const accountId = (session['metadata'] as Record<string, string>)['accountId']!;
    await handleStripeEvent(env, event('checkout.session.completed', session));
    expect(await balance(accountId)).toBe(0);
    await handleStripeEvent(
      env,
      event('checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' }),
    );
    expect(await balance(accountId)).toBe(net(1000, defaultFee(1087)));
  });

  it('ignores subscription checkouts and payments that are not credits', async () => {
    const sub = await checkoutSession({ mode: 'subscription', subscription: 'sub_1' });
    const other = await checkoutSession({
      metadata: { kind: 'something-else', accountId: uniq('u_acct') },
    });
    await handleStripeEvent(env, event('checkout.session.completed', sub));
    await handleStripeEvent(env, event('checkout.session.completed', other));
    for (const s of [sub, other]) {
      expect(await grantsFor(env, (s['metadata'] as Record<string, string>)['accountId']!)).toEqual(
        [],
      );
    }
  });

  it('finds the account through the Stripe customer when metadata lacks it', async () => {
    const { customer, accountId } = await userWithCustomer();
    const session = await checkoutSession({ customer, metadata: { kind: 'credits' } });
    await handleStripeEvent(env, event('checkout.session.completed', session));
    expect(await balance(accountId)).toBe(net(1000, defaultFee(1087)));
  });

  it('credits a subscription invoice its subtotal minus the fee, once per invoice', async () => {
    const { customer, accountId } = await userWithCustomer();
    // $10.00 + 85¢ tax; Stripe's fee 66¢.
    const first = await invoice(
      customer,
      { billing_reason: 'subscription_create', subtotal: 1000 },
      { fee: 66 },
    );
    const renewal = await invoice(customer, { subtotal: 1000 });
    await handleStripeEvent(env, event('invoice.paid', first));
    await handleStripeEvent(env, event('invoice.paid', first));
    await handleStripeEvent(env, event('invoice.paid', renewal));
    expect(await grantDetailsFor(env, accountId)).toEqual([
      {
        kind: 'subscription',
        amount_micros: 9_340_000,
        gross_micros: 10_000_000,
        fee_micros: 660_000,
        stripe_ref: first['id'],
      },
      {
        kind: 'subscription',
        amount_micros: net(1000, defaultFee(1085)),
        gross_micros: 10_000_000,
        fee_micros: defaultFee(1085) * 10_000,
        stripe_ref: renewal['id'],
      },
    ]);
    const listed = await stripeCalls('/v1/invoice_payments');
    expect(listed.filter((c) => c.query['invoice'] === first['id'])).toHaveLength(1);
    expect(listed.find((c) => c.query['invoice'] === first['id'])!.query['status']).toBe('paid');
  });

  it('credits every paid subscription invoice with a positive subtotal, prorated ones included', async () => {
    const { customer, accountId } = await userWithCustomer();
    const update = await invoice(
      customer,
      { billing_reason: 'subscription_update', subtotal: 512 },
      { fee: 50 },
    );
    const threshold = await invoice(
      customer,
      { billing_reason: 'subscription_threshold', subtotal: 300 },
      { fee: 40 },
    );
    await handleStripeEvent(env, event('invoice.paid', update));
    await handleStripeEvent(env, event('invoice.paid', threshold));
    // A prorated downgrade can net to zero or less, and a trial invoice is $0: nothing to credit.
    for (const subtotal of [0, -250]) {
      await handleStripeEvent(
        env,
        event(
          'invoice.paid',
          await invoice(customer, { billing_reason: 'subscription_update', subtotal }, null),
        ),
      );
    }
    const grants = await grantsFor(env, accountId);
    expect(grants).toHaveLength(2);
    expect(grants).toEqual(
      expect.arrayContaining([
        { kind: 'subscription', amount_micros: net(512, 50), stripe_ref: update['id'] },
        { kind: 'subscription', amount_micros: net(300, 40), stripe_ref: threshold['id'] },
      ]),
    );
  });

  it('credits a $0 trial invoice nothing, without asking Stripe for a fee', async () => {
    const { customer, accountId } = await userWithCustomer();
    const trial = await invoice(
      customer,
      { billing_reason: 'subscription_create', subtotal: 0, amount_paid: 0 },
      null,
    );
    await handleStripeEvent(env, event('invoice.paid', trial));
    expect(await grantsFor(env, accountId)).toEqual([]);
    const listed = await stripeCalls('/v1/invoice_payments');
    expect(listed.some((c) => c.query['invoice'] === trial['id'])).toBe(false);
  });

  it('charges no fee on an invoice paid entirely from the customer balance', async () => {
    const { customer, accountId } = await userWithCustomer();
    const inv = await invoice(customer, { subtotal: 1000, amount_paid: 0 }, null);
    await handleStripeEvent(env, event('invoice.paid', inv));
    expect(await grantDetailsFor(env, accountId)).toEqual([
      {
        kind: 'subscription',
        amount_micros: 10_000_000,
        gross_micros: 10_000_000,
        fee_micros: 0,
        stripe_ref: inv['id'],
      },
    ]);
  });

  it("throws (so Stripe retries) when a paid invoice's fee cannot be read yet", async () => {
    const { customer, accountId } = await userWithCustomer();
    const pending = await invoice(customer, {}, { balanceTransaction: false });
    await expect(handleStripeEvent(env, event('invoice.paid', pending))).rejects.toThrow(
      /balance transaction/,
    );
    const noPayment = await invoice(customer, {}, null);
    await expect(handleStripeEvent(env, event('invoice.paid', noPayment))).rejects.toThrow(
      /No paid Stripe payment/,
    );
    expect(await grantsFor(env, accountId)).toEqual([]);
  });

  it('ignores invoices that are not for a subscription', async () => {
    const { customer, accountId } = await userWithCustomer();
    await handleStripeEvent(
      env,
      event('invoice.paid', await invoice(customer, { parent: null, billing_reason: 'manual' })),
    );
    await handleStripeEvent(
      env,
      event('invoice.paid', await invoice(customer, { parent: { type: 'quote_details' } })),
    );
    expect(await grantsFor(env, accountId)).toEqual([]);
  });

  it('throws (so Stripe retries) for a subscription invoice of an unknown customer', async () => {
    await expect(
      handleStripeEvent(env, event('invoice.paid', await invoice(uniq('cus_unknown')))),
    ).rejects.toThrow(/No user/);
  });

  // Refunds debit the pre-tax refund in full: Stripe keeps its fee on a refund.
  it('debits the pre-tax share of each refund, once per refund', async () => {
    const accountId = uniq('u_acct');
    const pi = uniq('pi');
    const chargeId = uniq('ch');
    await stripeFixtures({
      checkoutSessions: [
        {
          id: uniq('cs'),
          object: 'checkout.session',
          mode: 'payment',
          payment_intent: pi,
          amount_subtotal: 1000,
          amount_total: 1100,
          metadata: { kind: 'credits', accountId },
        },
      ],
    });
    const refundA = {
      id: uniq('re'),
      object: 'refund',
      amount: 550,
      status: 'succeeded',
      charge: chargeId,
    };
    const refundB = {
      id: uniq('re'),
      object: 'refund',
      amount: 550,
      status: 'succeeded',
      charge: chargeId,
    };
    const failed = {
      id: uniq('re'),
      object: 'refund',
      amount: 999,
      status: 'failed',
      charge: chargeId,
    };
    const charge = (refunds: unknown[]) => ({
      id: chargeId,
      object: 'charge',
      amount: 1100,
      amount_refunded: 550 * refunds.length,
      currency: 'usd',
      customer: uniq('cus'),
      payment_intent: pi,
      refunds: { object: 'list', data: refunds, has_more: false },
    });
    await handleStripeEvent(env, event('charge.refunded', charge([refundA, failed])));
    await handleStripeEvent(env, event('charge.refunded', charge([refundA, refundB])));
    expect(await grantsFor(env, accountId)).toEqual([
      { kind: 'refund', amount_micros: -5_000_000, stripe_ref: refundA.id },
      { kind: 'refund', amount_micros: -5_000_000, stripe_ref: refundB.id },
    ]);
  });

  it('lists refunds when the charge does not embed them, and uses the customer', async () => {
    const { customer, accountId } = await userWithCustomer();
    const chargeId = uniq('ch');
    const refund = {
      id: uniq('re'),
      object: 'refund',
      amount: 2000,
      status: 'succeeded',
      charge: chargeId,
    };
    await stripeFixtures({ refunds: [refund] });
    await handleStripeEvent(
      env,
      event('charge.refunded', {
        id: chargeId,
        object: 'charge',
        amount: 2170,
        amount_refunded: 2000,
        currency: 'usd',
        customer,
        payment_intent: uniq('pi_invoice'),
      }),
    );
    expect(await grantsFor(env, accountId)).toEqual([
      { kind: 'refund', amount_micros: -20_000_000, stripe_ref: refund.id },
    ]);
    const listed = await stripeCalls('/v1/refunds');
    expect(listed.some((c) => c.query['charge'] === chargeId)).toBe(true);
  });

  it('ignores unrelated events', async () => {
    await expect(
      handleStripeEvent(env, event('customer.subscription.updated', { id: 'sub_1' })),
    ).resolves.toBeUndefined();
    await expect(
      handleStripeEvent(env, event('payment_intent.succeeded', { id: 'pi_1' })),
    ).resolves.toBeUndefined();
  });

  it('throws on D1 errors so Stripe retries', async () => {
    const broken = envWithFailingDb(env, /INSERT INTO credit_grants/);
    await expect(
      handleStripeEvent(broken, event('checkout.session.completed', await checkoutSession())),
    ).rejects.toThrow(/D1_ERROR/);
  });
});
