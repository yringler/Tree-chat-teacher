import { env as rawEnv } from 'cloudflare:workers';
import type Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBalance, grantCredit } from '../src/billing/ledger.js';
import { handleStripeEvent } from '../src/billing/webhook.js';
import type { AppEnv } from '../src/env.js';
import {
  envWithFailingDb,
  grantDetailsFor,
  grantsFor,
  insertSubscription,
  insertUser,
  stripeCalls,
  stripeFixtures,
  uniq,
} from './mocks/billing-helpers.js';
import { defaultFeeDetails, type MockPaymentIntent } from './mocks/stripe.js';

const env = rawEnv as unknown as AppEnv;
const MEMBERSHIP_PRICE = 'price_test_membership';
/** The membership sold and required, and the built-in provider offered (vitest.config.ts). */
const memberEnv: AppEnv = { ...env, STRIPE_MEMBERSHIP_PRICE_ID: MEMBERSHIP_PRICE };

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
 * A paid yearly membership invoice ($10.00 + tax) whose line is `price`
 * (default: the membership price). Its PaymentIntent and invoice payment are
 * registered with the Stripe mock, so a refund of the charge finds the invoice.
 */
async function invoice(
  customer: string,
  overrides: Record<string, unknown> = {},
  price: string = MEMBERSHIP_PRICE,
): Promise<Record<string, unknown> & { id: string; paymentIntent: string }> {
  const subtotal = (overrides['subtotal'] as number | undefined) ?? 1000;
  const total = Math.max(0, Math.round(subtotal * 1.085));
  const pi = uniq('pi_inv');
  const inv = {
    id: uniq('in_test'),
    object: 'invoice',
    customer,
    currency: 'usd',
    billing_reason: 'subscription_create',
    subtotal,
    total,
    amount_paid: total,
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: uniq('sub'), metadata: {} },
    },
    lines: {
      object: 'list',
      has_more: false,
      data: [
        {
          id: uniq('il'),
          object: 'line_item',
          amount: subtotal,
          pricing: { type: 'price_details', price_details: { price, product: 'prod_membership' } },
        },
      ],
    },
    ...overrides,
    paymentIntent: pi,
  };
  if (total > 0) {
    await stripeFixtures({
      paymentIntents: [{ id: pi, amount: total }],
      invoicePayments: [
        {
          id: uniq('inpay'),
          object: 'invoice_payment',
          invoice: inv.id,
          status: 'paid',
          amount_paid: total,
          amount_requested: total,
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

  it('grants the included credit once per paid membership invoice, with no fee lookup', async () => {
    const { customer, accountId } = await userWithCustomer();
    const first = await invoice(customer);
    const renewal = await invoice(customer, { billing_reason: 'subscription_cycle' });
    await handleStripeEvent(memberEnv, event('invoice.paid', first));
    await handleStripeEvent(memberEnv, event('invoice.paid', first)); // redelivery
    await handleStripeEvent(memberEnv, event('invoice.paid', renewal));
    const gift = {
      kind: 'subscription',
      amount_micros: 2_000_000,
      gross_micros: null,
      fee_micros: 0,
    };
    expect(await grantDetailsFor(env, accountId)).toEqual([
      { ...gift, stripe_ref: first.id },
      { ...gift, stripe_ref: renewal.id },
    ]);
    const note = await env.DB.prepare('SELECT note FROM credit_grants WHERE stripe_ref = ?')
      .bind(first.id)
      .first<{ note: string }>();
    expect(note?.note).toBe('Included with membership');
    // A fixed gift: Stripe's fee on the invoice is never looked up.
    const listed = await stripeCalls('/v1/invoice_payments');
    expect(listed.some((c) => c.query['invoice'] === first.id)).toBe(false);
    // Learn's ledger u_<userId>, shared with power.
    expect(accountId).toMatch(/^u_/);
  });

  it('grants MEMBERSHIP_CREDIT_CENTS as configured', async () => {
    const { customer, accountId } = await userWithCustomer();
    await handleStripeEvent(
      { ...memberEnv, MEMBERSHIP_CREDIT_CENTS: '500' },
      event('invoice.paid', await invoice(customer)),
    );
    expect(await balance(accountId)).toBe(5_000_000);
  });

  it('recognises a renewal on an older price by the plugin subscription row', async () => {
    const { userId, customer, accountId } = await userWithCustomer();
    const pluginId = await insertSubscription(env, userId, 'active', {
      stripeSubscriptionId: uniq('sub_old'),
    });
    const byMetadata = await invoice(
      customer,
      {
        parent: {
          type: 'subscription_details',
          subscription_details: {
            subscription: uniq('sub'),
            metadata: { subscriptionId: pluginId },
          },
        },
      },
      'price_old_membership',
    );
    const stripeSub = uniq('sub_stripe');
    await insertSubscription(env, userId, 'active', { stripeSubscriptionId: stripeSub });
    const bySubscription = await invoice(
      customer,
      {
        parent: {
          type: 'subscription_details',
          subscription_details: { subscription: stripeSub, metadata: null },
        },
      },
      'price_old_membership',
    );
    await handleStripeEvent(memberEnv, event('invoice.paid', byMetadata));
    await handleStripeEvent(memberEnv, event('invoice.paid', bySubscription));
    expect((await grantsFor(env, accountId)).map((g) => g.stripe_ref)).toEqual([
      byMetadata.id,
      bySubscription.id,
    ]);
  });

  it('grants nothing for another subscription, a $0 invoice, or without the built-in provider', async () => {
    const { userId, customer, accountId } = await userWithCustomer();
    // Another plan's subscription (e.g. a monthly plan from before the membership).
    const otherSub = uniq('sub_other');
    await insertSubscription(env, userId, 'active', {
      plan: 'monthly-10',
      stripeSubscriptionId: otherSub,
    });
    await handleStripeEvent(
      memberEnv,
      event(
        'invoice.paid',
        await invoice(
          customer,
          {
            parent: {
              type: 'subscription_details',
              subscription_details: { subscription: otherSub, metadata: {} },
            },
          },
          'price_monthly_10',
        ),
      ),
    );
    // A trial or a 100% discount: nothing was paid.
    await handleStripeEvent(
      memberEnv,
      event('invoice.paid', await invoice(customer, { subtotal: 0, total: 0, amount_paid: 0 })),
    );
    // The built-in provider isn't offered (no operator key): nothing is promised or granted.
    for (const e of [
      { ...memberEnv, SIMPLE_PROVIDER: '', OPENROUTER_SIMPLE_API_KEY: '' },
      { ...memberEnv, MEMBERSHIP_CREDIT_CENTS: '0' },
    ] as AppEnv[]) {
      await handleStripeEvent(e, event('invoice.paid', await invoice(customer)));
    }
    expect(await grantsFor(env, accountId)).toEqual([]);
  });

  it('ignores invoices that are not for a subscription', async () => {
    const { customer, accountId } = await userWithCustomer();
    await handleStripeEvent(
      memberEnv,
      event('invoice.paid', await invoice(customer, { parent: null, billing_reason: 'manual' })),
    );
    await handleStripeEvent(
      memberEnv,
      event('invoice.paid', await invoice(customer, { parent: { type: 'quote_details' } })),
    );
    expect(await grantsFor(env, accountId)).toEqual([]);
  });

  it('throws (so Stripe retries) for a membership invoice of an unknown customer', async () => {
    await expect(
      handleStripeEvent(memberEnv, event('invoice.paid', await invoice(uniq('cus_unknown')))),
    ).rejects.toThrow(/No user/);
  });

  it('a refund of a membership invoice takes back the included credit, once', async () => {
    const { customer, accountId } = await userWithCustomer();
    const inv = await invoice(customer);
    await handleStripeEvent(memberEnv, event('invoice.paid', inv));
    const chargeId = uniq('ch');
    const refund = (amount: number, created: number) => ({
      id: uniq('re'),
      object: 'refund',
      amount,
      created,
      status: 'succeeded',
      charge: chargeId,
    });
    const partial = refund(500, 1_800_000_000);
    const rest = refund(585, 1_800_000_100);
    const charge = (refunds: unknown[]) => ({
      id: chargeId,
      object: 'charge',
      amount: 1085,
      amount_refunded: 1085,
      currency: 'usd',
      customer,
      payment_intent: inv.paymentIntent,
      refunds: { object: 'list', data: refunds, has_more: false },
    });
    await handleStripeEvent(memberEnv, event('charge.refunded', charge([partial])));
    // A second partial refund (Stripe lists the newest first) and a redelivery add nothing.
    await handleStripeEvent(memberEnv, event('charge.refunded', charge([rest, partial])));
    await handleStripeEvent(memberEnv, event('charge.refunded', charge([rest, partial])));
    // The first refund failing later, and the operator refunding again, still adds nothing.
    const retry = refund(1085, 1_800_000_200);
    await handleStripeEvent(
      memberEnv,
      event('charge.refunded', charge([retry, rest, { ...partial, status: 'failed' }])),
    );
    expect(await grantsFor(env, accountId)).toEqual([
      { kind: 'subscription', amount_micros: 2_000_000, stripe_ref: inv.id },
      { kind: 'refund', amount_micros: -2_000_000, stripe_ref: partial.id },
    ]);
    expect(await balance(accountId)).toBe(0);
  });

  it('a refund of a membership invoice that included no credit debits nothing', async () => {
    const { customer, accountId } = await userWithCustomer();
    const noBuiltIn = {
      ...memberEnv,
      SIMPLE_PROVIDER: '',
      OPENROUTER_SIMPLE_API_KEY: '',
    } as AppEnv;
    const inv = await invoice(customer);
    await handleStripeEvent(noBuiltIn, event('invoice.paid', inv));
    const chargeId = uniq('ch');
    await handleStripeEvent(
      memberEnv,
      event('charge.refunded', {
        id: chargeId,
        object: 'charge',
        amount: 1085,
        amount_refunded: 1085,
        currency: 'usd',
        customer,
        payment_intent: inv.paymentIntent,
        refunds: {
          object: 'list',
          has_more: false,
          data: [
            { id: uniq('re'), amount: 1085, created: 1, status: 'succeeded', charge: chargeId },
          ],
        },
      }),
    );
    expect(await grantsFor(env, accountId)).toEqual([]);
  });

  it('a refund of a monthly-plan invoice from before the membership is debited as before', async () => {
    const { customer, accountId } = await userWithCustomer();
    const inv = await invoice(customer, {}, 'price_monthly_10');
    // What the monthly plans credited: the subtotal net of the fee.
    await grantCredit(env.DB, {
      accountId,
      kind: 'subscription',
      amountMicros: 9_340_000,
      grossMicros: 10_000_000,
      feeMicros: 660_000,
      stripeRef: inv.id,
    });
    const refundId = uniq('re');
    const chargeId = uniq('ch');
    await handleStripeEvent(
      memberEnv,
      event('charge.refunded', {
        id: chargeId,
        object: 'charge',
        amount: 1085,
        amount_refunded: 1085,
        currency: 'usd',
        customer,
        payment_intent: inv.paymentIntent,
        refunds: {
          object: 'list',
          has_more: false,
          data: [{ id: refundId, amount: 1085, created: 1, status: 'succeeded', charge: chargeId }],
        },
      }),
    );
    expect((await grantsFor(env, accountId)).at(-1)).toEqual({
      kind: 'refund',
      amount_micros: -10_850_000,
      stripe_ref: refundId,
    });
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
