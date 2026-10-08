// The Polar adapter's outbound side, against the sandbox API mock
// (test/mocks/polar.ts): request bodies, 404 handling, error mapping.
import { describe, expect, it } from 'vitest';
import { PaymentProviderError, type ProviderRef } from '../src/billing/payments/port.js';
import { createPolarProvider } from '../src/billing/providers/polar/adapter.js';
import type { PolarConfig } from '../src/billing/providers/polar/config.js';
import { dispute, order, TEST_WEBHOOK_SECRET } from './fixtures/polar.js';
import { uniq } from './mocks/billing-helpers.js';
import type { MockPolarCall } from './mocks/polar.js';

const CONFIG: PolarConfig = {
  accessToken: 'polar_oat_test',
  webhookSecret: TEST_WEBHOOK_SECRET,
  server: 'sandbox',
  creditsProductId: 'prod_credits',
  membershipProductId: 'prod_membership',
  feeEstimate: { bps: 500, fixedCents: 50 },
};
const polar = createPolarProvider(CONFIG);
const MOCK = 'https://sandbox-api.polar.sh';

async function calls(path: string): Promise<MockPolarCall[]> {
  return (await (
    await fetch(`${MOCK}/__mock/calls?path=${encodeURIComponent(path)}`)
  ).json()) as MockPolarCall[];
}

async function objects(o: {
  customers?: string[];
  subscriptions?: Record<string, unknown>[];
  orders?: unknown[];
  disputes?: unknown[];
}): Promise<void> {
  const res = await fetch(`${MOCK}/__mock/objects`, { method: 'POST', body: JSON.stringify(o) });
  if (!res.ok) throw new Error(`polar mock: ${res.status}`);
}

function buyer(userId = uniq('user')) {
  return { userId, email: `${userId}@example.com`, name: 'Ada', customerRef: null };
}

describe('Polar checkouts', () => {
  it('opens a top-up with an ad-hoc, tax-exclusive USD price and the metadata the webhook reads', async () => {
    const b = buyer();
    const session = await polar.createTopUpCheckout({
      buyer: b,
      amountCents: 2500,
      successUrl: 'https://app.example/learn/billing?checkout=success',
      cancelUrl: 'https://app.example/learn/billing?checkout=cancel',
    });
    expect(session.url).toMatch(/^https:\/\/sandbox\.polar\.sh\/checkout\/polar_c_\d+$/);
    const [call] = (await calls('/v1/checkouts/')).filter(
      (c) => c.body?.['external_customer_id'] === b.userId,
    );
    expect(call).toMatchObject({ method: 'POST', polarVersion: '2026-10', authorized: true });
    expect(call!.body).toEqual({
      products: ['prod_credits'],
      prices: {
        prod_credits: [
          {
            amount_type: 'fixed',
            price_amount: 2500,
            price_currency: 'usd',
            tax_behavior: 'exclusive',
          },
        ],
      },
      currency: 'usd',
      external_customer_id: b.userId,
      customer_email: b.email,
      customer_name: 'Ada',
      metadata: {
        kind: 'credits',
        target: 'personal',
        userId: b.userId,
        v: 1,
      },
      success_url: 'https://app.example/learn/billing?checkout=success',
      return_url: 'https://app.example/learn/billing?checkout=cancel',
    });
  });

  it('opens the membership checkout on the yearly product', async () => {
    const b = buyer();
    await polar.createMembershipCheckout({
      buyer: b,
      successUrl: 'https://s',
      cancelUrl: 'https://c',
    });
    const [call] = (await calls('/v1/checkouts/')).filter(
      (c) => c.body?.['external_customer_id'] === b.userId,
    );
    expect(call!.body).toEqual({
      products: ['prod_membership'],
      currency: 'usd',
      external_customer_id: b.userId,
      customer_email: b.email,
      customer_name: 'Ada',
      metadata: { kind: 'membership', userId: b.userId, v: 1 },
      success_url: 'https://s',
      return_url: 'https://c',
    });
  });

  it('refuses what isn’t configured, and reports API failures as retryable', async () => {
    const bare = createPolarProvider({
      ...CONFIG,
      creditsProductId: null,
      membershipProductId: null,
    });
    expect(bare.capabilities).toEqual({ topUps: false, membership: false });
    await expect(
      bare.createMembershipCheckout({ buyer: buyer(), successUrl: 's', cancelUrl: 'c' }),
    ).rejects.toMatchObject({ name: 'PaymentProviderError', retryable: false });
    await expect(
      polar.createMembershipCheckout({
        buyer: buyer(uniq('fail_user')),
        successUrl: 's',
        cancelUrl: 'c',
      }),
    ).rejects.toMatchObject({ name: 'PaymentProviderError', status: 503, retryable: true });
    const unauthorized = createPolarProvider({ ...CONFIG, accessToken: 'nope' });
    await expect(
      unauthorized.createMembershipCheckout({ buyer: buyer(), successUrl: 's', cancelUrl: 'c' }),
    ).rejects.toMatchObject({ status: 401, retryable: false });
  });
});

describe('Polar customer portal', () => {
  it('opens a portal session for a known customer, and reports none for a stranger', async () => {
    const known = buyer();
    await objects({ customers: [known.userId] });
    const session = await polar.createPortalSession({ buyer: known, returnUrl: 'https://r' });
    expect(session).toEqual({
      url: expect.stringMatching(/^https:\/\/sandbox\.polar\.sh\/tangent\/portal\?/),
      customerRef: `cus_of_${known.userId}`,
    });
    const [call] = (await calls('/v1/customer-sessions/')).filter(
      (c) => c.body?.['external_customer_id'] === known.userId,
    );
    expect(call!.body).toEqual({ external_customer_id: known.userId, return_url: 'https://r' });
    expect(await polar.createPortalSession({ buyer: buyer(), returnUrl: 'https://r' })).toBeNull();
  });
});

describe('Polar customer deletion', () => {
  it('revokes active subscriptions, then anonymises the customer', async () => {
    const b = buyer();
    const subId = uniq('sub');
    await objects({
      customers: [b.userId],
      subscriptions: [{ id: subId, external_customer_id: b.userId, status: 'active' }],
    });
    expect(await polar.deleteCustomer(b)).toBe('deleted');
    expect(await calls(`/v1/subscriptions/${subId}`)).toMatchObject([{ method: 'DELETE' }]);
    expect(await calls(`/v1/customers/external/${b.userId}`)).toMatchObject([
      { method: 'DELETE', query: { anonymize: ['true'] } },
    ]);
    // Done already: nothing left.
    expect(await polar.deleteCustomer(b)).toBe('absent');
  });

  it('reports a customer Polar never had as absent, and failures as errors', async () => {
    expect(await polar.deleteCustomer(buyer())).toBe('absent');
    await expect(polar.deleteCustomer(buyer(uniq('fail_user')))).rejects.toBeInstanceOf(
      PaymentProviderError,
    );
  });
});

describe('Polar payments and disputes', () => {
  it('looks up an order as payment facts', async () => {
    const id = uniq('ord');
    await objects({ orders: [order({ id, externalId: 'user_7' })] });
    expect(await polar.getPayment(`polar:order:${id}` as ProviderRef)).toMatchObject({
      paymentRef: `polar:order:${id}`,
      purpose: { kind: 'credits' },
      userId: 'user_7',
      netCents: 1000,
    });
    expect(await polar.getPayment('polar:order:missing' as ProviderRef)).toBeNull();
    expect(await polar.getPayment('fake:order:x' as ProviderRef)).toBeNull();
  });

  it('polls disputes with the statuses that matter, newest first', async () => {
    if (polar.disputes.mode !== 'poll') throw new Error('expected a polled dispute source');
    const open = uniq('dsp');
    const prevented = uniq('dsp');
    await objects({
      disputes: [
        dispute({ id: open, created_at: '2026-10-05T13:00:00.000Z' }),
        dispute({ id: prevented, status: 'prevented' }),
      ],
    });
    const events = await polar.disputes.poll(new Date('2026-10-05T14:00:00.000Z'));
    expect(events.find((e) => e.disputeRef === `polar:dispute:${open}`)).toEqual({
      type: 'dispute.opened',
      provider: 'polar',
      occurredAt: '2026-10-05T14:00:00.000Z',
      disputeRef: `polar:dispute:${open}`,
      paymentRef: 'polar:order:ord_1',
      currency: 'usd',
      netCents: 1000,
    });
    expect(events.some((e) => e.disputeRef === `polar:dispute:${prevented}`)).toBe(false);
    const [call] = (await calls('/v1/disputes/')).slice(-1);
    expect(call!.query).toMatchObject({
      status: ['needs_response', 'under_review', 'lost', 'won'],
      sorting: ['-created_at'],
      limit: ['100'],
      page: ['1'],
    });
  });
});
