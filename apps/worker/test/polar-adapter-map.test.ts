// The Polar adapter's inbound side: signed deliveries (synthetic fixtures,
// test/fixtures/polar.ts) through the real `webhooks.validateEvent` inside
// `parseWebhook`, mapped to neutral payment events; and the pure mappings.
import { describe, expect, it, vi } from 'vitest';
import { WebhookSignatureError, type PaymentEvent } from '../src/billing/payments/port.js';
import { createPolarProvider } from '../src/billing/providers/polar/adapter.js';
import type { PolarConfig } from '../src/billing/providers/polar/config.js';
import { disputeEvent, membershipEvent, orderFee } from '../src/billing/providers/polar/map.js';
import {
  dispute,
  envelope,
  order,
  refund,
  signStandardWebhook,
  subscription,
  TEST_WEBHOOK_SECRET,
} from './fixtures/polar.js';

const CONFIG: PolarConfig = {
  accessToken: 'polar_oat_test',
  webhookSecret: TEST_WEBHOOK_SECRET,
  server: 'sandbox',
  creditsProductId: 'prod_credits',
  membershipProductId: 'prod_membership',
  feeEstimate: { bps: 500, fixedCents: 50 },
};
const polar = createPolarProvider(CONFIG);
const T0 = '2026-10-05T12:00:00.000Z';

async function deliver(payload: unknown, o: { secret?: string; timestamp?: number } = {}) {
  const rawBody = JSON.stringify(payload);
  const headers = await signStandardWebhook(rawBody, o.secret ?? TEST_WEBHOOK_SECRET, {
    id: 'msg_1',
    ...(o.timestamp !== undefined ? { timestamp: o.timestamp } : {}),
  });
  return polar.parseWebhook({ rawBody, headers });
}

async function eventsOf(payload: unknown): Promise<readonly PaymentEvent[]> {
  const result = await deliver(payload);
  if (result.kind !== 'events') throw new Error(`ignored: ${result.reason}`);
  expect(result.deliveryId).toBe('msg_1');
  return result.events;
}

describe('Polar webhooks: orders', () => {
  it('maps a paid credits order to payment.succeeded, pre-tax, with Polar’s fee', async () => {
    expect(await eventsOf(envelope('order.paid', order({ id: 'ord_a' })))).toEqual([
      {
        type: 'payment.succeeded',
        provider: 'polar',
        occurredAt: T0,
        paymentRef: 'polar:order:ord_a',
        purpose: { kind: 'credits', target: 'personal', accountId: 'u_user_1' },
        userId: 'user_1',
        customerRef: 'cus_of_user_1',
        currency: 'usd',
        netCents: 1000,
        taxCents: 87,
        fee: { cents: 104, estimated: false },
      },
    ]);
  });

  it('reads the pool target and account from the metadata; an unknown target stays unknown', async () => {
    const pool = order({
      metadata: { kind: 'credits', target: 'pool', accountId: 'pool', userId: 'user_1', v: 1 },
    });
    expect((await eventsOf(envelope('order.paid', pool)))[0]).toMatchObject({
      purpose: { kind: 'credits', target: 'pool', accountId: 'pool' },
    });
    const odd = order({ metadata: { kind: 'credits', target: 'charity' } });
    expect((await eventsOf(envelope('order.paid', odd)))[0]).toMatchObject({
      purpose: { kind: 'credits', target: 'unknown', accountId: null },
      // No external id on the customer: the metadata's userId, here absent.
    });
  });

  it('falls back to metadata.userId when the customer has no external id', async () => {
    const o = order({ externalId: null, metadata: { kind: 'credits', userId: 'user_9' } });
    expect((await eventsOf(envelope('order.paid', o)))[0]).toMatchObject({
      userId: 'user_9',
      purpose: { kind: 'credits', target: 'personal', accountId: null },
    });
  });

  it('maps membership orders: first year and renewals only', async () => {
    const base = {
      product_id: 'prod_membership',
      subscription_id: 'sub_1',
      metadata: { kind: 'membership', userId: 'user_1' },
    };
    const first = order({ ...base, billing_reason: 'subscription_create' });
    const renewal = order({ ...base, billing_reason: 'subscription_cycle' });
    const update = order({ ...base, billing_reason: 'subscription_update' });
    expect((await eventsOf(envelope('order.paid', first)))[0]).toMatchObject({
      purpose: {
        kind: 'membership',
        cycle: 'initial',
        subscriptionRef: 'polar:subscription:sub_1',
      },
    });
    expect((await eventsOf(envelope('order.paid', renewal)))[0]).toMatchObject({
      purpose: { kind: 'membership', cycle: 'renewal' },
    });
    expect((await eventsOf(envelope('order.paid', update)))[0]).toMatchObject({
      purpose: { kind: 'other' },
    });
    // A product change keeps renewals recognised through the metadata.
    const moved = order({ ...base, product_id: 'prod_old', billing_reason: 'subscription_cycle' });
    expect((await eventsOf(envelope('order.paid', moved)))[0]).toMatchObject({
      purpose: { kind: 'membership', cycle: 'renewal' },
    });
  });

  it('passes another currency through (the domain refuses it)', async () => {
    const eur = order({ currency: 'EUR', platform_fee_currency: 'eur' });
    expect((await eventsOf(envelope('order.paid', eur)))[0]).toMatchObject({ currency: 'eur' });
  });

  it('ignores pending orders and checkout events', async () => {
    expect(await deliver(envelope('order.created', order({ status: 'pending' })))).toMatchObject({
      kind: 'ignored',
      reason: 'order.created',
    });
  });
});

describe('Polar fees', () => {
  it('uses platform_fee_amount, else the configured estimate on the total', () => {
    expect(orderFee(order({ platform_fee_amount: 104 }), CONFIG)).toEqual({
      cents: 104,
      estimated: false,
    });
    // 1087 × 5% = 54.35 → 55, + 50¢.
    expect(orderFee(order({ platform_fee_amount: 0 }), CONFIG)).toEqual({
      cents: 105,
      estimated: true,
    });
    expect(orderFee(order({ platform_fee_currency: 'eur' }), CONFIG)).toMatchObject({
      estimated: true,
    });
    // A free order has no fee.
    expect(
      orderFee(order({ net_amount: 0, tax_amount: 0, platform_fee_amount: 0 }), CONFIG),
    ).toEqual({ cents: 0, estimated: false });
  });
});

describe('Polar webhooks: refunds', () => {
  it('maps a settled refund, and ignores pending ones', async () => {
    expect(await eventsOf(envelope('refund.updated', refund({ id: 'ref_a' })))).toEqual([
      {
        type: 'refund.succeeded',
        provider: 'polar',
        occurredAt: T0,
        refundRef: 'polar:refund:ref_a',
        paymentRef: 'polar:order:ord_1',
        currency: 'usd',
        netCents: 500,
        taxCents: 44,
      },
    ]);
    for (const status of ['pending', 'failed', 'canceled'] as const)
      expect(await deliver(envelope('refund.created', refund({ status })))).toMatchObject({
        kind: 'ignored',
      });
  });
});

describe('Polar webhooks: the membership subscription', () => {
  it('maps each subscription event to a normalised snapshot', async () => {
    expect(await eventsOf(envelope('subscription.active', subscription()))).toEqual([
      {
        type: 'membership.changed',
        provider: 'polar',
        occurredAt: T0,
        subscriptionRef: 'polar:subscription:sub_1',
        userId: 'user_1',
        customerRef: 'cus_of_user_1',
        status: 'active',
        providerStatus: 'active',
        currentPeriodEnd: '2027-10-05T12:00:00.000Z',
        cancelAtPeriodEnd: false,
        endedAt: null,
        version: '2026-10-05T12:00:05.000Z',
      },
    ]);
    const canceled = subscription({
      cancel_at_period_end: true,
      modified_at: '2026-11-01T00:00:00Z',
    });
    expect((await eventsOf(envelope('subscription.canceled', canceled)))[0]).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
      version: '2026-11-01T00:00:00.000Z',
    });
    const revoked = subscription({ status: 'canceled', ended_at: '2027-10-05T12:00:00Z' });
    expect((await eventsOf(envelope('subscription.revoked', revoked)))[0]).toMatchObject({
      status: 'canceled',
      endedAt: '2027-10-05T12:00:00.000Z',
    });
    const pastDue = subscription({ status: 'past_due' });
    expect((await eventsOf(envelope('subscription.past_due', pastDue)))[0]).toMatchObject({
      status: 'past_due',
    });
  });

  it('normalises statuses and versions; other subscriptions are ignored', () => {
    expect(
      membershipEvent(subscription({ status: 'incomplete_expired' }), CONFIG, T0),
    ).toMatchObject({ status: 'canceled', providerStatus: 'incomplete_expired' });
    expect(membershipEvent(subscription({ modified_at: null }), CONFIG, T0)?.version).toBe(T0);
    expect(
      membershipEvent(subscription({ product_id: 'prod_other', metadata: {} }), CONFIG, T0),
    ).toBeNull();
  });

  it('logs a membership subscription whose user is unknown', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const anon = subscription({ externalId: null, metadata: { kind: 'membership' } });
    expect(await deliver(envelope('subscription.active', anon))).toMatchObject({ kind: 'ignored' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('polar_membership_without_user'));
    error.mockRestore();
  });
});

describe('Polar webhooks: verification', () => {
  it('rejects a bad signature, a wrong secret and a stale timestamp', async () => {
    const payload = envelope('order.paid', order());
    const rawBody = JSON.stringify(payload);
    const headers = await signStandardWebhook(rawBody);
    await expect(
      polar.parseWebhook({ rawBody: rawBody.replace('1000', '9000'), headers }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(
      deliver(payload, { secret: `whsec_${btoa('another secret, 32 bytes long....')}` }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(
      deliver(payload, { timestamp: Math.floor(Date.now() / 1000) - 600 }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(polar.parseWebhook({ rawBody, headers: new Headers() })).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
  });

  it('acknowledges signed types it does not know', async () => {
    expect(await deliver({ type: 'payout.created', timestamp: T0, data: {} })).toMatchObject({
      kind: 'ignored',
      deliveryId: 'msg_1',
      reason: 'unknown type payout.created',
    });
  });
});

describe('Polar disputes', () => {
  it('maps open, lost and won disputes, net of tax; prevented ones map to nothing', () => {
    expect(disputeEvent(dispute({ id: 'dsp_a' }), T0)).toEqual({
      type: 'dispute.opened',
      occurredAt: T0,
      disputeRef: 'polar:dispute:dsp_a',
      paymentRef: 'polar:order:ord_1',
      currency: 'usd',
      netCents: 1000,
    });
    expect(disputeEvent(dispute({ status: 'under_review' }), T0)?.type).toBe('dispute.opened');
    expect(disputeEvent(dispute({ status: 'lost' }), T0)?.type).toBe('dispute.lost');
    expect(disputeEvent(dispute({ status: 'won' }), T0)?.type).toBe('dispute.won');
    expect(disputeEvent(dispute({ status: 'prevented' }), T0)).toBeNull();
    expect(disputeEvent(dispute({ status: 'early_warning' }), T0)).toBeNull();
  });
});
