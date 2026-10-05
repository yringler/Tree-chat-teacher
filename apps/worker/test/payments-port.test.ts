import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env.js';
import {
  paymentProvider,
  paymentsConfigured,
  webhookProvider,
  WebhookSignatureError,
  type PaymentEvent,
  type PaymentFacts,
  type ProviderRef,
  type TopUpCheckoutInput,
} from '../src/billing/payments/index.js';
import {
  isReservedRef,
  membershipRefundRef,
  providerOfRef,
  providerRef,
  reinstatedRef,
} from '../src/billing/payments/refs.js';
import {
  createFakeProvider,
  decodeFakeUrl,
  FAKE_SIGNATURE,
  FAKE_SIGNATURE_HEADER,
} from '../src/billing/providers/fake.js';

const env = rawEnv as unknown as AppEnv;

describe('payment refs', () => {
  it('namespaces provider object ids and derives the secondary keys', () => {
    const order = providerRef('polar', 'order', '6c1e');
    expect(order).toBe('polar:order:6c1e');
    expect(providerOfRef(order)).toBe('polar');
    expect(membershipRefundRef(order)).toBe('polar:order:6c1e:membership-refund');
    const dispute = providerRef('fake', 'dispute', 'd1');
    expect(reinstatedRef(dispute)).toBe('fake:dispute:d1:reinstated');
  });

  it('refuses refs that would be ambiguous', () => {
    expect(() => providerRef('polar', '', 'x')).toThrow();
    expect(() => providerRef('polar', 'a:b', 'x')).toThrow();
    expect(() => providerRef('polar', 'order', '')).toThrow();
  });

  it('knows the reserved non-payment prefixes', () => {
    expect(isReservedRef('admin:k1')).toBe(true);
    expect(isReservedRef('dev:k1')).toBe(true);
    expect(isReservedRef('polar:order:1')).toBe(false);
  });
});

describe('fake payment provider', () => {
  const input: TopUpCheckoutInput = {
    buyer: { userId: 'u1', email: 'ada@example.com', name: 'Ada Ünïcode', customerRef: null },
    target: 'pool',
    accountId: 'pool',
    amountCents: 1234,
    successUrl: 'https://app.example/billing?checkout=success',
    cancelUrl: 'https://app.example/billing?checkout=cancel',
  };

  it('encodes what the domain asked for in its URLs', async () => {
    const fake = createFakeProvider();
    const checkout = await fake.createTopUpCheckout(input);
    expect(checkout).toEqual({
      url: expect.stringMatching(/^https:\/\/fake-pay\.invalid\/checkout#/),
    });
    expect(decodeFakeUrl(checkout.url)).toEqual({ page: 'checkout', input });
    const portal = await fake.createPortalSession({ buyer: input.buyer, returnUrl: 'https://r' });
    expect(decodeFakeUrl(portal!.url)).toEqual({
      page: 'portal',
      input: { buyer: input.buyer, returnUrl: 'https://r' },
    });
  });

  it('follows its options', async () => {
    const payment: PaymentFacts = {
      paymentRef: 'fake:order:o1' as ProviderRef,
      purpose: { kind: 'credits', target: 'personal', accountId: 'u_u1' },
      userId: 'u1',
      customerRef: null,
      currency: 'usd',
      netCents: 1000,
      taxCents: 0,
      fee: { cents: 80, estimated: false },
    };
    const fake = createFakeProvider({
      topUps: false,
      portalCustomer: false,
      deleteResult: 'deleted',
      customerRef: 'cust_1',
      payments: [payment],
      disputes: [],
    });
    expect(fake.capabilities).toEqual({ topUps: false, membership: true });
    expect(await fake.createPortalSession({ buyer: input.buyer, returnUrl: 'x' })).toBeNull();
    expect(await fake.deleteCustomer({ userId: 'u1', customerRef: null })).toBe('deleted');
    expect((await fake.createMembershipCheckout({ ...input })).customerRef).toBe('cust_1');
    expect(await fake.getPayment(payment.paymentRef)).toEqual(payment);
    expect(await fake.getPayment('fake:order:nope' as ProviderRef)).toBeNull();
    expect(fake.disputes.mode).toBe('poll');
    expect(createFakeProvider().disputes.mode).toBe('none');
    await expect(
      createFakeProvider({ deleteResult: 'error' }).deleteCustomer({
        userId: 'u',
        customerRef: null,
      }),
    ).rejects.toMatchObject({ name: 'PaymentProviderError', retryable: true });
  });

  it('verifies and parses webhook deliveries', async () => {
    const fake = createFakeProvider();
    const event: PaymentEvent = {
      type: 'refund.succeeded',
      provider: 'fake',
      occurredAt: '2026-10-05T00:00:00.000Z',
      refundRef: 'fake:refund:r1' as ProviderRef,
      paymentRef: 'fake:order:o1' as ProviderRef,
      currency: 'usd',
      netCents: 100,
      taxCents: 0,
    };
    const signed = new Headers({ [FAKE_SIGNATURE_HEADER]: FAKE_SIGNATURE });
    expect(
      await fake.parseWebhook({
        rawBody: JSON.stringify({ id: 'd1', events: [event] }),
        headers: signed,
      }),
    ).toEqual({ kind: 'events', deliveryId: 'd1', events: [event] });
    expect(
      await fake.parseWebhook({
        rawBody: JSON.stringify({ id: 'd2', events: [] }),
        headers: signed,
      }),
    ).toMatchObject({ kind: 'ignored', deliveryId: 'd2' });
    await expect(
      fake.parseWebhook({ rawBody: '{}', headers: new Headers() }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(fake.parseWebhook({ rawBody: 'nope', headers: signed })).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
  });
});

describe('payment provider selection', () => {
  it('builds the fake from FAKE_PAYMENTS in tests', () => {
    const e = { ...env, PAYMENT_PROVIDER: 'fake', FAKE_PAYMENTS: '{"topUps":false}' } as AppEnv;
    const provider = paymentProvider(e);
    expect(provider?.id).toBe('fake');
    expect(provider?.capabilities.topUps).toBe(false);
    expect(paymentsConfigured(e)).toBe(true);
    expect(webhookProvider(e, 'fake')?.id).toBe('fake');
    expect(webhookProvider(e, 'polar')).toBeNull();
  });

  it('refuses the fake outside tests and unknown providers', () => {
    expect(() =>
      paymentProvider({ ...env, PAYMENT_PROVIDER: 'fake', TEST_SEAMS: '' } as AppEnv),
    ).toThrow(/only allowed in tests/);
    expect(() => paymentProvider({ ...env, PAYMENT_PROVIDER: 'paypal' } as AppEnv)).toThrow(
      /Unknown PAYMENT_PROVIDER/,
    );
  });
});
