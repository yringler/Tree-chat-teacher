import { DomainError, ValidationError } from '@tangent/core';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createCreditCheckout } from '../src/billing/service.js';
import { ensureStripeCustomer, STRIPE_API_VERSION } from '../src/billing/stripe.js';
import type { AppEnv } from '../src/env.js';
import { insertUser, simpleAccount, stripeCalls, uniq } from './mocks/billing-helpers.js';
import type { MockStripeCall } from './mocks/stripe.js';

const env = rawEnv as unknown as AppEnv;
const BASE = 'https://tangent.example.com';

function metaOf(call: MockStripeCall): Record<string, string> {
  return (call.body['metadata'] ?? {}) as Record<string, string>;
}

async function newUser() {
  const account = simpleAccount();
  const user = await insertUser(env, {
    id: account.userId!,
    email: `${uniq('buyer')}@example.com`,
    name: 'Ada',
  });
  return { account, user };
}

async function storedCustomer(userId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT stripe_customer_id AS cid FROM auth_users WHERE id = ?')
    .bind(userId)
    .first<{ cid: string | null }>();
  return row?.cid ?? null;
}

describe('credit checkout', () => {
  it('rejects amounts outside $5..$500 and non-integers before calling Stripe', async () => {
    const { account, user } = await newUser();
    for (const cents of [499, 50_001, 0, -500, 1000.5]) {
      await expect(createCreditCheckout(env, account, user, cents, BASE)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(
      (await stripeCalls('/v1/customers')).filter((c) => c.body['email'] === user.email),
    ).toEqual([]);
  });

  it('creates the customer once and a tax-exclusive payment Checkout Session', async () => {
    const { account, user } = await newUser();
    const first = await createCreditCheckout(env, account, user, 500, `${BASE}/`);
    const second = await createCreditCheckout(env, account, user, 50_000, BASE);
    expect(first.url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_mock_\d+$/);
    expect(second.url).not.toBe(first.url);

    const customers = (await stripeCalls('/v1/customers')).filter(
      (c) => c.body['email'] === user.email,
    );
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({
      method: 'POST',
      idempotencyKey: `customer-${user.id}`,
      stripeVersion: STRIPE_API_VERSION,
      authorized: true,
      body: { email: user.email, name: 'Ada', metadata: { userId: user.id, customerType: 'user' } },
    });
    const customerId = await storedCustomer(user.id);
    expect(customerId).toMatch(/^cus_mock_/);

    const sessions = (await stripeCalls('/v1/checkout/sessions')).filter(
      (c) => c.method === 'POST' && metaOf(c)['accountId'] === account.id,
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.stripeVersion).toBe('2026-08-26.dahlia');
    expect(sessions[0]!.body).toEqual({
      mode: 'payment',
      customer: customerId,
      customer_update: { address: 'auto', name: 'auto' },
      billing_address_collection: 'required',
      automatic_tax: { enabled: 'true' },
      invoice_creation: { enabled: 'true' },
      line_items: {
        0: {
          quantity: '1',
          price_data: {
            currency: 'usd',
            product: 'prod_test',
            unit_amount: '500',
            tax_behavior: 'exclusive',
          },
        },
      },
      client_reference_id: account.id,
      metadata: { kind: 'credits', accountId: account.id, amountCents: '500' },
      payment_intent_data: {
        metadata: { kind: 'credits', accountId: account.id, amountCents: '500' },
      },
      success_url: `${BASE}/learn/billing?checkout=success`,
      cancel_url: `${BASE}/learn/billing?checkout=cancel`,
    });
    expect(
      (sessions[1]!.body['line_items'] as Record<string, Record<string, Record<string, string>>>)[
        '0'
      ]!['price_data']!['unit_amount'],
    ).toBe('50000');
  });

  it('reuses a customer id the plugin already stored', async () => {
    const account = simpleAccount();
    const user = await insertUser(env, { id: account.userId!, stripeCustomerId: 'cus_existing_1' });
    expect(await ensureStripeCustomer(env, user)).toBe('cus_existing_1');
    await createCreditCheckout(env, account, user, 1000, BASE);
    expect(
      (await stripeCalls('/v1/customers')).filter((c) => c.body['email'] === user.email),
    ).toEqual([]);
    const session = (await stripeCalls('/v1/checkout/sessions')).find(
      (c) => metaOf(c)['accountId'] === account.id,
    );
    expect(session?.body['customer']).toBe('cus_existing_1');
  });

  it('refuses when billing is not configured or for power accounts', async () => {
    const { account, user } = await newUser();
    for (const e of [
      { ...env, STRIPE_SECRET_KEY: '' },
      { ...env, STRIPE_CREDITS_PRODUCT_ID: '' },
    ]) {
      const err = await createCreditCheckout(e, account, user, 1000, BASE).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).message).toBe('Billing is not configured');
    }
    const err = await createCreditCheckout(
      env,
      { id: `p_${user.id}`, mode: 'power', userId: user.id, operatorKeys: false },
      user,
      1000,
      BASE,
    ).catch((x: unknown) => x);
    expect((err as DomainError).code).toBe('forbidden');
  });
});
