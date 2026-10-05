// POST /api/webhooks/:provider end to end: the route's contract on the fake
// provider (signature, ignored deliveries, failures, order), two smoke tests
// with signed Polar deliveries through the real adapter, and the cron's
// dispute job.
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { getBalance } from '../src/billing/ledger.js';
import type { PaymentEvent } from '../src/billing/payments/port.js';
import { FAKE_SIGNATURE, FAKE_SIGNATURE_HEADER } from '../src/billing/providers/fake.js';
import { CRON_FREQUENT, cronTasks, type CronJobs } from '../src/cron.js';
import type { AppEnv } from '../src/env.js';
import {
  envelope,
  order,
  refund,
  signStandardWebhook,
  TEST_WEBHOOK_SECRET,
} from './fixtures/polar.js';
import { grantDetailsFor, insertUser, uniq } from './mocks/billing-helpers.js';
import { factsOf, membership, paid, refunded } from './mocks/payment-events.js';

const base = rawEnv as unknown as AppEnv;
const ORIGIN = 'https://tangent.example.com';
const app = createApp();
/** Auth configured: the route must answer without a session. */
const AUTH = { BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123' };
const fakeEnv = (options: object = {}) =>
  ({
    ...base,
    ...AUTH,
    PAYMENT_PROVIDER: 'fake',
    FAKE_PAYMENTS: JSON.stringify(options),
  }) as AppEnv;
const polarEnv = {
  ...base,
  ...AUTH,
  PAYMENT_PROVIDER: 'polar',
  POLAR_ACCESS_TOKEN: 'polar_oat_test',
  POLAR_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  POLAR_SERVER: 'sandbox',
  POLAR_CREDITS_PRODUCT_ID: 'prod_credits',
} as AppEnv;
const balance = async (accountId: string) => (await getBalance(base.DB, accountId)).balanceMicros;

function post(path: string, body: string, headers: HeadersInit, env: AppEnv) {
  return app.request(`${ORIGIN}${path}`, { method: 'POST', headers, body }, env);
}

function deliverFake(events: PaymentEvent[], env: AppEnv, signature = FAKE_SIGNATURE) {
  return post(
    '/api/webhooks/fake',
    JSON.stringify({ id: uniq('delivery'), events }),
    { [FAKE_SIGNATURE_HEADER]: signature, 'content-type': 'application/json' },
    env,
  );
}

async function newUser(): Promise<string> {
  const id = uniq('user');
  await insertUser(base, { id });
  return id;
}

describe('POST /api/webhooks/:provider (fake provider)', () => {
  it('applies a delivery’s events in order, without a session', async () => {
    const userId = await newUser();
    const payment = paid({ userId });
    const res = await deliverFake([payment, refunded(payment.paymentRef, 400)], fakeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect((await grantDetailsFor(base, `u_${userId}`)).map((g) => g.kind)).toEqual([
      'purchase',
      'refund',
    ]);
    // A redelivery changes nothing.
    expect((await deliverFake([payment], fakeEnv())).status).toBe(200);
    expect(await balance(`u_${userId}`)).toBe(9_200_000 - 4_000_000);
  });

  it('answers 403 to a bad signature and writes nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const userId = await newUser();
    const res = await deliverFake([paid({ userId })], fakeEnv(), 'forged');
    expect(res.status).toBe(403);
    expect(await balance(`u_${userId}`)).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('payment_webhook_rejected'));
    warn.mockRestore();
  });

  it('answers 202 to a verified delivery with nothing to apply', async () => {
    expect((await deliverFake([], fakeEnv())).status).toBe(202);
  });

  it('answers 500 (so the provider redelivers) when an event must be retried', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const userId = await newUser();
    const early = paid({ userId });
    const env = fakeEnv({ payments: [factsOf(early)] });
    const res = await deliverFake([refunded(early.paymentRef, 1000)], env);
    expect(res.status).toBe(500);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('payment_webhook_failed'));
    error.mockRestore();
    // Once the payment is in, the redelivered refund applies.
    await deliverFake([early], env);
    expect((await deliverFake([refunded(early.paymentRef, 1000)], env)).status).toBe(200);
  });

  it('stores membership snapshots', async () => {
    const userId = await newUser();
    expect((await deliverFake([membership(userId, 'active')], fakeEnv())).status).toBe(200);
    const row = await base.DB.prepare('SELECT status FROM billing_subscriptions WHERE user_id = ?')
      .bind(userId)
      .first<{ status: string }>();
    expect(row?.status).toBe('active');
  });

  it('is 404 for a provider that isn’t the active one', async () => {
    const res = await post('/api/webhooks/polar', '{}', {}, fakeEnv());
    expect(res.status).toBe(404);
    expect((await post('/api/webhooks/stripe', '{}', {}, fakeEnv())).status).toBe(404);
  });
});

describe('POST /api/webhooks/polar (smoke, signed synthetic deliveries)', () => {
  async function deliverPolar(payload: unknown) {
    const body = JSON.stringify(payload);
    return post('/api/webhooks/polar', body, await signStandardWebhook(body), polarEnv);
  }

  it('credits a paid order, then debits its refund', async () => {
    const userId = await newUser();
    const orderId = uniq('ord');
    const paidOrder = order({
      id: orderId,
      externalId: userId,
      metadata: { kind: 'credits', target: 'personal', accountId: `u_${userId}`, userId, v: 1 },
    });
    expect((await deliverPolar(envelope('order.paid', paidOrder))).status).toBe(200);
    expect(await grantDetailsFor(base, `u_${userId}`)).toEqual([
      {
        kind: 'purchase',
        amount_micros: (1000 - 104) * 10_000,
        gross_micros: 10_000_000,
        fee_micros: 1_040_000,
        provider_ref: `polar:order:${orderId}`,
      },
    ]);
    const refundId = uniq('ref');
    const settled = refund({ id: refundId, order_id: orderId, amount: 500, status: 'succeeded' });
    expect((await deliverPolar(envelope('refund.updated', settled))).status).toBe(200);
    expect((await grantDetailsFor(base, `u_${userId}`))[1]).toMatchObject({
      kind: 'refund',
      amount_micros: -5_000_000,
      provider_ref: `polar:refund:${refundId}`,
    });
    expect(await balance(`u_${userId}`)).toBe(8_960_000 - 5_000_000);
  });

  it('rejects an unsigned delivery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await post(
      '/api/webhooks/polar',
      JSON.stringify(envelope('order.paid', order())),
      { 'content-type': 'application/json' },
      polarEnv,
    );
    expect(res.status).toBe(403);
    warn.mockRestore();
  });
});

describe('the dispute cron job', () => {
  it('runs every 10 minutes, and a failure never rejects the cron', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const jobs = {
      reconcile: vi.fn(() => Promise.resolve()),
      poolExpiry: vi.fn(() => Promise.resolve()),
      poolImpact: vi.fn(() => Promise.resolve()),
      paymentDisputes: vi.fn(() => Promise.reject(new Error('Polar is down'))),
      poolRevenueShare: vi.fn(() => Promise.resolve()),
      priceSync: vi.fn(() => Promise.resolve()),
    } satisfies CronJobs;
    await expect(
      Promise.all(cronTasks(CRON_FREQUENT, base, new Date(), jobs)),
    ).resolves.toBeDefined();
    expect(jobs.paymentDisputes).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('Payment dispute poll failed', expect.any(Error));
    error.mockRestore();
  });
});
