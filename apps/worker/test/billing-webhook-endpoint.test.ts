// End to end through the Better Auth Stripe plugin's real endpoint,
// /api/auth/stripe/webhook (signature check → plugin handlers → our onEvent).
import { env as rawEnv } from 'cloudflare:workers';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getBalance } from '../src/billing/ledger.js';
import type { AppEnv } from '../src/env.js';
import { grantsFor, insertUser, stripeFixtures, uniq } from './mocks/billing-helpers.js';

const ORIGIN = 'https://tangent.example.com';
/** Auth configured (the default test env runs in dev-bypass mode); Stripe as in vitest.config.ts. */
const env = {
  ...(rawEnv as unknown as AppEnv),
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
} as AppEnv;
const app = createApp();

async function deliver(
  event: Record<string, unknown>,
  secret = env.STRIPE_WEBHOOK_SECRET!,
): Promise<Response> {
  const payload = JSON.stringify(event);
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
  return app.request(
    `${ORIGIN}/api/auth/stripe/webhook`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    },
    env,
  );
}

function eventOf(type: string, object: Record<string, unknown>): Record<string, unknown> {
  return {
    id: uniq('evt'),
    object: 'event',
    api_version: '2026-08-26.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

describe('Stripe webhook endpoint', () => {
  it('credits a paid top-up once (net of Stripe’s fee) despite the plugin’s subscription lookup', async () => {
    const accountId = uniq('u_acct');
    const paymentIntent = uniq('pi_test');
    await stripeFixtures({ paymentIntents: [{ id: paymentIntent, amount: 2180, fee: 104 }] });
    const session = {
      id: uniq('cs_test'),
      object: 'checkout.session',
      mode: 'payment',
      payment_status: 'paid',
      status: 'complete',
      currency: 'usd',
      amount_subtotal: 2000,
      amount_total: 2180,
      customer: uniq('cus'),
      subscription: null,
      client_reference_id: accountId,
      payment_intent: paymentIntent,
      metadata: { kind: 'credits', accountId, amountCents: '2000' },
    };
    const first = await deliver(eventOf('checkout.session.completed', session));
    expect(first.status, await first.text()).toBe(200);
    const again = await deliver(eventOf('checkout.session.completed', session));
    expect(again.status).toBe(200);

    expect(await grantsFor(env, accountId)).toEqual([
      { kind: 'purchase', amount_micros: 18_960_000, stripe_ref: session.id },
    ]);
    expect((await getBalance(env.DB, accountId)).balanceMicros).toBe(18_960_000);
  });

  it('credits a subscription invoice through the endpoint', async () => {
    const userId = uniq('user');
    const customer = uniq('cus');
    await insertUser(env, { id: userId, stripeCustomerId: customer });
    const invoice = {
      id: uniq('in_test'),
      object: 'invoice',
      customer,
      currency: 'usd',
      billing_reason: 'subscription_create',
      subtotal: 1000,
      total: 1090,
      amount_paid: 1090,
      parent: { type: 'subscription_details', subscription_details: { subscription: uniq('sub') } },
    };
    const paymentIntent = uniq('pi_test');
    await stripeFixtures({
      paymentIntents: [{ id: paymentIntent, amount: 1090, fee: 67 }],
      invoicePayments: [
        {
          id: uniq('inpay'),
          object: 'invoice_payment',
          invoice: invoice.id,
          status: 'paid',
          amount_paid: 1090,
          payment: { type: 'payment_intent', payment_intent: paymentIntent },
        },
      ],
    });
    const res = await deliver(eventOf('invoice.paid', invoice));
    expect(res.status, await res.text()).toBe(200);
    expect((await getBalance(env.DB, `u_${userId}`)).balanceMicros).toBe(9_330_000);
  });

  it('rejects a bad signature without crediting', async () => {
    const accountId = uniq('u_acct');
    const session = {
      id: uniq('cs_test'),
      object: 'checkout.session',
      mode: 'payment',
      payment_status: 'paid',
      currency: 'usd',
      amount_subtotal: 2000,
      subscription: null,
      metadata: { kind: 'credits', accountId },
    };
    const res = await deliver(eventOf('checkout.session.completed', session), 'whsec_wrong');
    expect(res.status).toBe(400);
    expect(await grantsFor(env, accountId)).toEqual([]);
  });

  it('answers 400 (so Stripe retries) when fulfilment fails', async () => {
    const res = await deliver(
      eventOf('invoice.paid', {
        id: uniq('in_test'),
        object: 'invoice',
        customer: uniq('cus_unknown'),
        currency: 'usd',
        billing_reason: 'subscription_cycle',
        subtotal: 1000,
        parent: { type: 'subscription_details' },
      }),
    );
    expect(res.status).toBe(400);
  });
});
