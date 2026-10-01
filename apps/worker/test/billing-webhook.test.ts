import { env as rawEnv } from 'cloudflare:workers';
import type Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBalance } from '../src/billing/ledger.js';
import { handleStripeEvent } from '../src/billing/webhook.js';
import type { AppEnv } from '../src/env.js';
import {
  envWithFailingDb,
  grantsFor,
  insertUser,
  stripeCalls,
  stripeFixtures,
  uniq,
} from './mocks/billing-helpers.js';

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

function checkoutSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    metadata: { kind: 'credits', accountId: uniq('u_acct'), amountCents: '1000' },
    ...overrides,
  };
}

function invoice(
  customer: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: uniq('in_test'),
    object: 'invoice',
    customer,
    currency: 'usd',
    billing_reason: 'subscription_cycle',
    subtotal: 2000,
    total: 2170,
    parent: { type: 'subscription_details', subscription_details: { subscription: uniq('sub') } },
    ...overrides,
  };
}

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
  it('credits a paid top-up its pre-tax subtotal, once per session', async () => {
    const session = checkoutSession();
    const accountId = (session['metadata'] as Record<string, string>)['accountId']!;
    await handleStripeEvent(env, event('checkout.session.completed', session));
    await handleStripeEvent(env, event('checkout.session.completed', session));
    await handleStripeEvent(
      env,
      event('checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' }),
    );
    expect(await grantsFor(env, accountId)).toEqual([
      { kind: 'purchase', amount_micros: 10_000_000, stripe_ref: session['id'] },
    ]);
    expect(await balance(accountId)).toBe(10_000_000);
  });

  it('waits for async payment methods to succeed', async () => {
    const session = checkoutSession({ payment_status: 'unpaid' });
    const accountId = (session['metadata'] as Record<string, string>)['accountId']!;
    await handleStripeEvent(env, event('checkout.session.completed', session));
    expect(await balance(accountId)).toBe(0);
    await handleStripeEvent(
      env,
      event('checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' }),
    );
    expect(await balance(accountId)).toBe(10_000_000);
  });

  it('ignores subscription checkouts and payments that are not credits', async () => {
    const sub = checkoutSession({ mode: 'subscription', subscription: 'sub_1' });
    const other = checkoutSession({
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
    const session = checkoutSession({ customer, metadata: { kind: 'credits' } });
    await handleStripeEvent(env, event('checkout.session.completed', session));
    expect(await balance(accountId)).toBe(10_000_000);
  });

  it('credits a subscription invoice its subtotal, once per invoice', async () => {
    const { customer, accountId } = await userWithCustomer();
    const first = invoice(customer, { billing_reason: 'subscription_create', subtotal: 1000 });
    const renewal = invoice(customer, { subtotal: 1000 });
    await handleStripeEvent(env, event('invoice.paid', first));
    await handleStripeEvent(env, event('invoice.paid', first));
    await handleStripeEvent(env, event('invoice.paid', renewal));
    expect(await grantsFor(env, accountId)).toEqual([
      { kind: 'subscription', amount_micros: 10_000_000, stripe_ref: first['id'] },
      { kind: 'subscription', amount_micros: 10_000_000, stripe_ref: renewal['id'] },
    ]);
  });

  it('credits every paid subscription invoice with a positive subtotal, prorated ones included', async () => {
    const { customer, accountId } = await userWithCustomer();
    const update = invoice(customer, { billing_reason: 'subscription_update', subtotal: 512 });
    const threshold = invoice(customer, {
      billing_reason: 'subscription_threshold',
      subtotal: 300,
    });
    await handleStripeEvent(env, event('invoice.paid', update));
    await handleStripeEvent(env, event('invoice.paid', threshold));
    // A prorated downgrade can net to zero or less: nothing to credit.
    await handleStripeEvent(
      env,
      event(
        'invoice.paid',
        invoice(customer, { billing_reason: 'subscription_update', subtotal: 0 }),
      ),
    );
    await handleStripeEvent(
      env,
      event(
        'invoice.paid',
        invoice(customer, { billing_reason: 'subscription_update', subtotal: -250 }),
      ),
    );
    const grants = await grantsFor(env, accountId);
    expect(grants).toHaveLength(2);
    expect(grants).toEqual(
      expect.arrayContaining([
        { kind: 'subscription', amount_micros: 5_120_000, stripe_ref: update['id'] },
        { kind: 'subscription', amount_micros: 3_000_000, stripe_ref: threshold['id'] },
      ]),
    );
  });

  it('ignores invoices that are not for a subscription', async () => {
    const { customer, accountId } = await userWithCustomer();
    await handleStripeEvent(
      env,
      event('invoice.paid', invoice(customer, { parent: null, billing_reason: 'manual' })),
    );
    await handleStripeEvent(
      env,
      event('invoice.paid', invoice(customer, { parent: { type: 'quote_details' } })),
    );
    expect(await grantsFor(env, accountId)).toEqual([]);
  });

  it('throws (so Stripe retries) for a subscription invoice of an unknown customer', async () => {
    await expect(
      handleStripeEvent(env, event('invoice.paid', invoice(uniq('cus_unknown')))),
    ).rejects.toThrow(/No user/);
  });

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
      handleStripeEvent(broken, event('checkout.session.completed', checkoutSession())),
    ).rejects.toThrow(/D1_ERROR/);
  });
});
