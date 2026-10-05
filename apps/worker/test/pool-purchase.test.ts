// Buying credit for the community pool (docs/pool/PLAN.md §S5): checkout
// targets, the webhook's pool fulfilment (net of the processing fee), refunds and
// disputes through PoolBank.debit, the admin's credit route and pool panel.
import {
  POOL_FUND_PRESETS_CENTS,
  type AdminCreditResponse,
  type AdminPoolResponse,
  type ApiError,
  type CheckoutResponse,
  type TreeDetail,
} from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- `?raw` is a Vite import; the worker tsconfig has no vite/client types.
import wranglerText from '../wrangler.jsonc?raw';
import { createApp } from '../src/app.js';
import { getBalance } from '../src/billing/ledger.js';
import { fulfilPurchase } from '../src/billing/purchases.js';
import { handleStripeEvent } from '../src/billing/webhook.js';
import { appConfig } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { poolBank } from '../src/pool/ids.js';
import { isSupporter } from '../src/pool/supporter.js';
import {
  insertUsage,
  insertUser,
  stripeCalls,
  stripeFixtures,
  uniq,
} from './mocks/billing-helpers.js';
import { defaultFeeDetails, type MockStripeCall } from './mocks/stripe.js';
import { fundPool, poolAccess, poolReadyUser } from './pool-helpers.js';
import { authEnv } from './session-client.js';

const env = rawEnv as unknown as AppEnv;
const ORIGIN = 'https://tangent.example.com';
/**
 * A $10 pool purchase through the Stripe mock (total $10.87 with tax): $10
 * minus the mock's default fee on the total, 2.9% + 30¢ + 0.5% (67¢).
 */
const TEN_DOLLARS_NET = 9_330_000;

interface GrantRow {
  account_id: string;
  kind: string;
  amount_micros: number;
  gross_micros: number | null;
  fee_micros: number;
  margin_bps: number;
  user_id: string | null;
  provider_ref: string | null;
  note: string | null;
}

async function grants(accountId: string): Promise<GrantRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT account_id, kind, amount_micros, gross_micros, fee_micros, margin_bps, user_id, provider_ref, note
     FROM credit_grants WHERE account_id = ? ORDER BY created_at, id`,
  )
    .bind(accountId)
    .all<GrantRow>();
  return results;
}

const balance = async (accountId: string) => (await getBalance(env.DB, accountId)).balanceMicros;

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

function event(type: string, object: Record<string, unknown>): Stripe.Event {
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
  } as unknown as Stripe.Event;
}

/** Delivers `ev` signed, through the Better Auth Stripe plugin's real endpoint. */
async function deliver(ev: Stripe.Event): Promise<Response> {
  const e = authEnv();
  const payload = JSON.stringify(ev);
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: e.STRIPE_WEBHOOK_SECRET!,
  });
  return createApp().request(
    `${ORIGIN}/api/auth/stripe/webhook`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    },
    e,
  );
}

/**
 * A paid credits Checkout Session ($10 + tax by default) for `target`, stored
 * with the Stripe mock (so refunds and disputes find it by its PaymentIntent)
 * and its PaymentIntent registered (so the fee can be read).
 */
async function paidSession(opts: {
  target?: 'pool' | 'personal' | null;
  accountId: string;
  userId?: string | null;
  subtotal?: number;
  total?: number;
}): Promise<Record<string, unknown> & { id: string; payment_intent: string }> {
  const subtotal = opts.subtotal ?? 1000;
  const total = opts.total ?? Math.round(subtotal * 1.087);
  const metadata: Record<string, string> = { kind: 'credits', accountId: opts.accountId };
  if (opts.target) metadata['target'] = opts.target;
  if (opts.userId) metadata['userId'] = opts.userId;
  const session = {
    id: uniq('cs_test'),
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    status: 'complete',
    currency: 'usd',
    amount_subtotal: subtotal,
    amount_total: total,
    customer: uniq('cus'),
    subscription: null,
    payment_intent: uniq('pi_test'),
    metadata,
  };
  await stripeFixtures({
    checkoutSessions: [session],
    paymentIntents: [{ id: session.payment_intent, amount: total }],
  });
  return session;
}

/** A charge of `session`'s PaymentIntent, refunded by `refunds`. */
function refundedCharge(
  session: { payment_intent: string },
  chargeId: string,
  refunds: { id: string; amount: number }[],
): Record<string, unknown> {
  return {
    id: chargeId,
    object: 'charge',
    amount: 1087,
    amount_refunded: refunds.reduce((n, r) => n + r.amount, 0),
    currency: 'usd',
    customer: uniq('cus'),
    payment_intent: session.payment_intent,
    refunds: {
      object: 'list',
      has_more: false,
      data: refunds.map((r) => ({
        ...r,
        object: 'refund',
        status: 'succeeded',
        charge: chargeId,
        created: 1,
      })),
    },
  };
}

function dispute(
  session: { payment_intent: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { id: string } {
  return {
    id: uniq('du'),
    object: 'dispute',
    amount: 1087,
    currency: 'usd',
    charge: uniq('ch'),
    payment_intent: session.payment_intent,
    status: 'needs_response',
    ...overrides,
  };
}

/** A pool of its own, with a buyer (a real user) and their purchase credited. */
async function poolPurchase(subtotal = 1000) {
  const poolId = uniq('pool');
  const buyer = uniq('user');
  await insertUser(env, { id: buyer });
  const session = await paidSession({ target: 'pool', accountId: poolId, userId: buyer, subtotal });
  await handleStripeEvent(env, event('checkout.session.completed', session));
  return { poolId, buyer, session };
}

describe('pool purchases through the Stripe webhook', () => {
  it('credits a signed pool event once, net of the fee, whichever events deliver it', async () => {
    const poolId = uniq('pool');
    const buyer = uniq('user');
    await insertUser(env, { id: buyer });
    const session = await paidSession({ target: 'pool', accountId: poolId, userId: buyer });
    const completed = event('checkout.session.completed', session);
    expect((await deliver(completed)).status).toBe(200);
    // The same signed event again (a redelivery), then the async-payment event for the session.
    expect((await deliver(completed)).status).toBe(200);
    expect((await deliver(event('checkout.session.async_payment_succeeded', session))).status).toBe(
      200,
    );

    const fee = defaultFeeDetails(1087);
    expect(await grants(poolId)).toEqual([
      {
        account_id: poolId,
        kind: 'purchase',
        amount_micros: TEN_DOLLARS_NET,
        gross_micros: 10_000_000,
        // The processing fee comes out of the credit, as for a personal top-up.
        fee_micros: (fee.stripe + fee.tax) * 10_000,
        margin_bps: 0,
        user_id: buyer,
        provider_ref: session.id,
        note: 'Community pool purchase',
      },
    ]);
    expect(await balance(poolId)).toBe(TEN_DOLLARS_NET);
    // The buyer's personal ledger is untouched, and they are now a supporter.
    expect(await balance(`u_${buyer}`)).toBe(0);
    expect(await isSupporter(env.DB, buyer, new Date(), null)).toBe(true);
  });

  it('takes no margin at purchase, whatever POOL_MARKUP_BPS says', async () => {
    const poolId = uniq('pool');
    const session = await paidSession({ target: 'pool', accountId: poolId, subtotal: 2000 });
    await handleStripeEvent(
      { ...env, POOL_MARKUP_BPS: '1000' } as AppEnv,
      event('checkout.session.completed', session),
    );
    const fee = defaultFeeDetails(2174);
    const feeCents = fee.stripe + fee.tax;
    expect(await grants(poolId)).toMatchObject([
      {
        amount_micros: (2000 - feeCents) * 10_000,
        gross_micros: 20_000_000,
        fee_micros: feeCents * 10_000,
        margin_bps: 0,
      },
    ]);
  });

  it('credits the configured pool when the session names no account', async () => {
    const poolId = uniq('pool');
    const session = await paidSession({ target: 'pool', accountId: '', userId: uniq('user') });
    await handleStripeEvent(
      { ...env, POOL_ACCOUNT_ID: poolId } as AppEnv,
      event('checkout.session.completed', session),
    );
    expect(await balance(poolId)).toBe(TEN_DOLLARS_NET);
  });

  it('credits sessions without a target (from before the pool) personally, recording the buyer', async () => {
    const userId = uniq('user');
    const accountId = `u_${userId}`;
    const session = await paidSession({ target: null, accountId });
    await handleStripeEvent(env, event('checkout.session.completed', session));
    const fee = defaultFeeDetails(1087);
    const feeCents = fee.stripe + fee.tax;
    expect(await grants(accountId)).toMatchObject([
      {
        kind: 'purchase',
        amount_micros: (1000 - feeCents) * 10_000,
        gross_micros: 10_000_000,
        fee_micros: feeCents * 10_000,
        margin_bps: 0,
        user_id: userId,
      },
    ]);
    // An explicit personal target is the same.
    const explicit = await paidSession({ target: 'personal', accountId, userId });
    await handleStripeEvent(env, event('checkout.session.completed', explicit));
    expect((await grants(accountId)).map((g) => g.provider_ref)).toEqual([session.id, explicit.id]);
  });

  it('ignores a credits session for an unknown target', async () => {
    const accountId = uniq('u_acct');
    const session = await paidSession({ target: null, accountId });
    (session['metadata'] as Record<string, string>)['target'] = 'charity';
    await handleStripeEvent(env, event('checkout.session.completed', session));
    expect(await grants(accountId)).toEqual([]);
  });
});

describe('pool purchase refunds and disputes', () => {
  it('a refund debits the credit-equivalent while the pool has it', async () => {
    const { poolId, buyer, session } = await poolPurchase();
    const refund = { id: uniq('re'), amount: 1087 };
    await handleStripeEvent(
      env,
      event('charge.refunded', refundedCharge(session, uniq('ch'), [refund])),
    );
    const rows = await grants(poolId);
    expect(rows[1]).toMatchObject({
      kind: 'refund',
      amount_micros: -TEN_DOLLARS_NET,
      gross_micros: -10_000_000,
      user_id: buyer,
      provider_ref: refund.id,
    });
    expect(rows[1]!.note).toContain(`requested=${TEN_DOLLARS_NET};shortfall=0`);
    expect(await balance(poolId)).toBe(0);
    // Refunded in full: no longer a supporter.
    expect(await isSupporter(env.DB, buyer, new Date(), null)).toBe(false);
  });

  it('a refund the pool cannot cover is written at 0, and never debited later', async () => {
    const { poolId, session } = await poolPurchase();
    // The pool spent everything it had.
    await insertUsage(env, {
      accountId: poolId,
      status: 'settled',
      chargeMicros: TEN_DOLLARS_NET,
    });
    const chargeId = uniq('ch');
    const first = { id: uniq('re'), amount: 543 };
    await handleStripeEvent(
      env,
      event('charge.refunded', refundedCharge(session, chargeId, [first])),
    );
    const refundRow = (await grants(poolId)).find((g) => g.provider_ref === first.id)!;
    // 543 of 1087 cents is 4.995400 $ pre-tax; credit-equivalent of what the purchase added.
    const requested = Math.round((4_995_400 * TEN_DOLLARS_NET) / 10_000_000);
    expect(refundRow).toMatchObject({ kind: 'refund', amount_micros: 0, gross_micros: -4_995_400 });
    expect(refundRow.note).toContain(`requested=${requested};shortfall=${requested}`);

    // Refilled: a redelivery, and a later partial refund listing the same refund again,
    // take nothing more for it (the new refund is debited on its own).
    await fundPool(poolId, 20_000_000);
    await handleStripeEvent(
      env,
      event('charge.refunded', refundedCharge(session, chargeId, [first])),
    );
    const second = { id: uniq('re'), amount: 100 };
    await handleStripeEvent(
      env,
      event('charge.refunded', refundedCharge(session, chargeId, [second, first])),
    );
    const refunds = (await grants(poolId)).filter((g) => g.kind === 'refund');
    expect(refunds.map((g) => g.provider_ref)).toEqual([first.id, second.id]);
    expect(refunds[0]!.amount_micros).toBe(0);
    expect(refunds[1]!.amount_micros).toBeLessThan(0);
    expect(await balance(poolId)).toBe(20_000_000 + refunds[1]!.amount_micros);
  });

  it('a dispute debits once, a won dispute credits it back once, a lost one suspends the buyer', async () => {
    const { poolId, buyer, session } = await poolPurchase();
    const d = dispute(session);
    await handleStripeEvent(env, event('charge.dispute.funds_withdrawn', d));
    await handleStripeEvent(env, event('charge.dispute.funds_withdrawn', d));
    let rows = await grants(poolId);
    expect(rows.filter((g) => g.provider_ref === d.id)).toMatchObject([
      {
        kind: 'refund',
        amount_micros: -TEN_DOLLARS_NET,
        gross_micros: -10_000_000,
        user_id: buyer,
      },
    ]);
    expect(await balance(poolId)).toBe(0);

    const won = { ...d, status: 'won' };
    await handleStripeEvent(env, event('charge.dispute.funds_reinstated', won));
    await handleStripeEvent(env, event('charge.dispute.funds_reinstated', won));
    rows = await grants(poolId);
    expect(rows.filter((g) => g.provider_ref === `${d.id}:reinstated`)).toMatchObject([
      { kind: 'refund', amount_micros: TEN_DOLLARS_NET, gross_micros: 10_000_000, user_id: buyer },
    ]);
    expect(await balance(poolId)).toBe(TEN_DOLLARS_NET);
    expect((await poolAccess(buyer))?.pool_suspended).toBe(0);

    // Another purchase's dispute is lost: its buyer loses pool access.
    const other = await poolPurchase();
    const lost = dispute(other.session, { status: 'lost' });
    await handleStripeEvent(env, event('charge.dispute.funds_withdrawn', lost));
    await handleStripeEvent(env, event('charge.dispute.closed', lost));
    expect((await poolAccess(other.buyer))?.pool_suspended).toBe(1);
    // Closing as won suspends no one.
    await handleStripeEvent(env, event('charge.dispute.closed', won));
    expect((await poolAccess(buyer))?.pool_suspended).toBe(0);
  });

  it('a dispute clamped by an empty pool is credited back only what it took', async () => {
    const { poolId, session } = await poolPurchase();
    await insertUsage(env, { accountId: poolId, status: 'settled', chargeMicros: 9_000_000 });
    const d = dispute(session);
    await handleStripeEvent(env, event('charge.dispute.funds_withdrawn', d));
    expect((await grants(poolId)).find((g) => g.provider_ref === d.id)?.amount_micros).toBe(
      -(TEN_DOLLARS_NET - 9_000_000),
    );
    expect(await balance(poolId)).toBe(0);
    await handleStripeEvent(env, event('charge.dispute.funds_reinstated', { ...d, status: 'won' }));
    expect(await balance(poolId)).toBe(TEN_DOLLARS_NET - 9_000_000);
  });

  it('a dispute of a personal top-up debits personal credit, unclamped', async () => {
    const userId = uniq('user');
    await insertUser(env, { id: userId });
    const accountId = `u_${userId}`;
    const session = await paidSession({ target: 'personal', accountId, userId });
    await handleStripeEvent(env, event('checkout.session.completed', session));
    const credited = await balance(accountId);
    const d = dispute(session);
    await handleStripeEvent(env, event('charge.dispute.funds_withdrawn', d));
    await handleStripeEvent(env, event('charge.dispute.funds_withdrawn', d));
    expect((await grants(accountId)).filter((g) => g.provider_ref === d.id)).toMatchObject([
      { kind: 'refund', amount_micros: -10_000_000, gross_micros: -10_000_000, user_id: userId },
    ]);
    // The fee was never credited, so the balance goes negative by it, as for refunds.
    expect(await balance(accountId)).toBe(credited - 10_000_000);
    await handleStripeEvent(env, event('charge.dispute.closed', { ...d, status: 'lost' }));
    expect((await poolAccess(userId))?.pool_suspended).toBe(1);
  });

  it('a refund of a personal top-up records its buyer and gross', async () => {
    const userId = uniq('user');
    const accountId = `u_${userId}`;
    const session = await paidSession({ target: 'personal', accountId, userId });
    const refund = { id: uniq('re'), amount: 1087 };
    await handleStripeEvent(
      env,
      event('charge.refunded', refundedCharge(session, uniq('ch'), [refund])),
    );
    expect(await grants(accountId)).toMatchObject([
      { kind: 'refund', amount_micros: -10_000_000, gross_micros: -10_000_000, user_id: userId },
    ]);
  });

  it('PoolBank.debit is idempotent on its ref and never takes the pool below 0', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 1_000);
    const bank = poolBank(env, poolId);
    const req = {
      poolId,
      refId: uniq('re'),
      requestedMicros: 5_000,
      kind: 'refund' as const,
      userId: null,
      grossMicros: -5_000,
      note: 'Refund',
    };
    expect(await bank.debit(req)).toEqual({
      debited: true,
      amountMicros: 1_000,
      shortfallMicros: 4_000,
    });
    expect(await bank.debit(req)).toEqual({
      debited: false,
      amountMicros: 1_000,
      shortfallMicros: 0,
    });
    expect(await balance(poolId)).toBe(0);
  });
});

describe('pool pricing', () => {
  it('offers presets from the minimum, and credits gross minus the fee (credit = gross − fee)', async () => {
    const { minPurchaseCents } = appConfig(env).pool;
    for (const cents of POOL_FUND_PRESETS_CENTS)
      expect(cents).toBeGreaterThanOrEqual(minPurchaseCents);
    const poolId = uniq('pool');
    await fulfilPurchase(env, {
      target: 'pool',
      userId: null,
      accountId: poolId,
      grossCents: 1000,
      processorFeeCents: 59,
      ref: `dev:${uniq('key')}`,
    });
    expect(await grants(poolId)).toMatchObject([
      { amount_micros: 9_410_000, gross_micros: 10_000_000, fee_micros: 590_000, margin_bps: 0 },
    ]);
  });

  it('fulfilPurchase is idempotent on its ref', async () => {
    const poolId = uniq('pool');
    const p = {
      target: 'pool' as const,
      userId: null,
      accountId: poolId,
      grossCents: 1000,
      processorFeeCents: 0,
      ref: `dev:${uniq('key')}`,
    };
    expect(await fulfilPurchase(env, p)).toBe(true);
    expect(await fulfilPurchase(env, p)).toBe(false);
    expect(await balance(poolId)).toBe(10_000_000);
  });
});

describe('POST /api/billing/checkout for the pool', () => {
  const sessionsOf = async (userId: string): Promise<MockStripeCall[]> =>
    (await stripeCalls('/v1/checkout/sessions')).filter(
      (c) =>
        c.method === 'POST' &&
        (c.body['metadata'] as Record<string, string> | undefined)?.['userId'] === userId,
    );

  it('opens a pool checkout from the pool minimum, naming the target, the pool and the buyer', async () => {
    const { client, poolId, userId } = await poolReadyUser({ funds: 0 });
    const checkout = (amountCents: number, target?: string) =>
      client.call('/api/billing/checkout', {
        method: 'POST',
        json: { amountCents, ...(target ? { target } : {}) },
        learn: 'pool',
      });
    expect((await json<ApiError>(await checkout(500, 'pool'), 400)).error.message).toMatch(
      /from 1000 to 50000 for the community pool/,
    );
    expect(await sessionsOf(userId)).toEqual([]);
    expect((await json<CheckoutResponse>(await checkout(1000, 'pool'))).url).toMatch(
      /^https:\/\/checkout\.stripe\.com\//,
    );
    // No target: a personal top-up, as before ($5 is enough there).
    await json<CheckoutResponse>(await checkout(500));
    await json<ApiError>(await checkout(1000, 'charity'), 400);

    const [pool, personal] = await sessionsOf(userId);
    const poolMeta = {
      kind: 'credits',
      target: 'pool',
      accountId: poolId,
      userId,
      amountCents: '1000',
    };
    expect(pool!.body).toMatchObject({
      mode: 'payment',
      metadata: poolMeta,
      payment_intent_data: { metadata: poolMeta },
      // The billing page then waits for the pool's balance, not the buyer's.
      success_url: `${ORIGIN}/learn/billing?checkout=success&target=pool`,
      cancel_url: `${ORIGIN}/learn/billing?checkout=cancel&target=pool`,
    });
    expect(personal!.body['success_url']).toBe(`${ORIGIN}/learn/billing?checkout=success`);
    expect(personal!.body['metadata']).toEqual({
      kind: 'credits',
      target: 'personal',
      accountId: `u_${userId}`,
      userId,
      amountCents: '500',
    });
  });

  it('refuses a pool checkout while the pool is off', async () => {
    const { client } = await poolReadyUser({ funds: 0 });
    const res = await client.call(
      '/api/billing/checkout',
      { method: 'POST', json: { amountCents: 1000, target: 'pool' } },
      authEnv({ POOL_ENABLED: 'false' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/credit', () => {
  /** An admin (and a regular user) on a pool of their own; `devPurchases` sets DEV_PURCHASES_ENABLED. */
  async function setup(opts: { devPurchases?: boolean; env?: Partial<AppEnv> } = {}) {
    const admin = await poolReadyUser({ funds: 0 });
    const user = await poolReadyUser({ poolId: admin.poolId, funds: 0 });
    const e = authEnv({
      POOL_ACCOUNT_ID: admin.poolId,
      ADMIN_USER_IDS: admin.userId,
      DEV_PURCHASES_ENABLED: opts.devPurchases ? 'true' : 'false',
      ...opts.env,
    });
    const credit = (body: Record<string, unknown>, as = admin) =>
      as.client.call('/api/admin/credit', { method: 'POST', json: body }, e);
    return { admin, user, poolId: admin.poolId, e, credit };
  }
  const key = () => uniq('key').slice(0, 40);

  it('adjusts a user’s personal credit once per idempotency key', async () => {
    const { user, credit } = await setup();
    const body = {
      target: 'personal',
      userId: user.userId,
      amountCents: 500,
      mode: 'adjustment',
      idempotencyKey: key(),
      note: 'Goodwill',
    };
    expect(await json<AdminCreditResponse>(await credit(body))).toEqual({
      credited: true,
      amountMicros: 5_000_000,
      balanceMicros: 5_000_000,
    });
    expect(await json<AdminCreditResponse>(await credit(body))).toEqual({
      credited: false,
      amountMicros: 5_000_000,
      balanceMicros: 5_000_000,
    });
    expect(await grants(`u_${user.userId}`)).toMatchObject([
      {
        kind: 'adjustment',
        amount_micros: 5_000_000,
        gross_micros: null,
        user_id: user.userId,
        provider_ref: `admin:${body.idempotencyKey}`,
        note: 'Goodwill',
      },
    ]);
    // Adjustments never make anyone a supporter.
    expect(await isSupporter(env.DB, user.userId, new Date(), null)).toBe(false);
  });

  it('adjusts the pool, clamping a debit to what it has', async () => {
    const { poolId, credit } = await setup();
    // No userId: an anonymous top-up (the same as `userId: null`).
    const add = { target: 'pool', mode: 'adjustment' };
    expect(
      await json<AdminCreditResponse>(
        await credit({ ...add, amountCents: 300, idempotencyKey: key() }),
      ),
    ).toEqual({ credited: true, amountMicros: 3_000_000, balanceMicros: 3_000_000 });
    const debit = { ...add, amountCents: -500, idempotencyKey: key() };
    expect(await json<AdminCreditResponse>(await credit(debit))).toEqual({
      credited: true,
      amountMicros: -3_000_000,
      balanceMicros: 0,
    });
    expect(await json<AdminCreditResponse>(await credit(debit))).toMatchObject({
      credited: false,
      amountMicros: -3_000_000,
    });
    const row = (await grants(poolId)).find(
      (g) => g.provider_ref === `admin:${debit.idempotencyKey}`,
    );
    expect(row).toMatchObject({ kind: 'adjustment', amount_micros: -3_000_000 });
    expect(row!.note).toContain('requested=5000000;shortfall=2000000');
  });

  it('validates: personal credit needs a user, amounts are bounded and non-zero', async () => {
    const { credit } = await setup({ devPurchases: true });
    const base = { target: 'personal', userId: null, amountCents: 100, mode: 'adjustment' };
    for (const body of [
      { ...base, idempotencyKey: key() },
      { ...base, userId: 'someone', amountCents: 0, idempotencyKey: key() },
      { ...base, userId: 'someone', amountCents: 50_001, idempotencyKey: key() },
      { ...base, userId: 'someone', idempotencyKey: 'short' },
      {
        ...base,
        target: 'pool',
        mode: 'simulated_purchase',
        amountCents: -100,
        idempotencyKey: key(),
      },
    ])
      await json<ApiError>(await credit(body), 400);
    await json<ApiError>(await credit({ ...base, userId: 'nobody', idempotencyKey: key() }), 404);
  });

  it('is 404 to non-admins and refuses cross-origin requests', async () => {
    const { user, credit, admin, e } = await setup();
    const body = {
      target: 'personal',
      userId: user.userId,
      amountCents: 500,
      mode: 'adjustment',
      idempotencyKey: key(),
    };
    expect((await json<ApiError>(await credit(body, user), 404)).error.code).toBe('not_found');
    const cross = await admin.client.call(
      '/api/admin/credit',
      { method: 'POST', json: body, headers: { 'Sec-Fetch-Site': 'cross-site' } },
      e,
    );
    expect(cross.status).toBe(403);
    expect(await balance(`u_${user.userId}`)).toBe(0);
  });

  it('simulates purchases only with DEV_PURCHASES_ENABLED: personal and pool', async () => {
    const off = await setup();
    const purchase = (userId: string, target: string) => ({
      target,
      userId,
      amountCents: 1000,
      mode: 'simulated_purchase',
      idempotencyKey: key(),
    });
    expect(
      (await json<ApiError>(await off.credit(purchase(off.user.userId, 'pool')), 404)).error.code,
    ).toBe('not_found');
    expect(await balance(off.poolId)).toBe(0);

    const on = await setup({ devPurchases: true });
    const pool = purchase(on.user.userId, 'pool');
    expect(await json<AdminCreditResponse>(await on.credit(pool))).toEqual({
      credited: true,
      amountMicros: 10_000_000,
      balanceMicros: 10_000_000,
    });
    expect(await json<AdminCreditResponse>(await on.credit(pool))).toMatchObject({
      credited: false,
    });
    expect(await grants(on.poolId)).toMatchObject([
      {
        kind: 'purchase',
        amount_micros: 10_000_000,
        gross_micros: 10_000_000,
        margin_bps: 0,
        user_id: on.user.userId,
        provider_ref: `dev:${pool.idempotencyKey}`,
      },
    ]);
    // A simulated purchase counts like a real one.
    expect(await isSupporter(env.DB, on.user.userId, new Date(), null)).toBe(true);

    const personal = purchase(on.user.userId, 'personal');
    expect(await json<AdminCreditResponse>(await on.credit(personal))).toEqual({
      credited: true,
      amountMicros: 10_000_000,
      balanceMicros: 10_000_000,
    });
  });

  it('the production config keeps simulated purchases off', async () => {
    const deployed = /"DEV_PURCHASES_ENABLED"\s*:\s*"([^"]*)"/.exec(wranglerText as string);
    expect(deployed?.[1]).toBe('false');
    const prod = { ...env, DEV_PURCHASES_ENABLED: deployed![1]! } as AppEnv;
    expect(appConfig(prod).flags.devPurchasesEnabled).toBe(false);
    // Unset is off too.
    const unset = { ...env } as Partial<AppEnv>;
    delete unset.DEV_PURCHASES_ENABLED;
    expect(appConfig(unset as AppEnv).flags.devPurchasesEnabled).toBe(false);
  });

  it('admin-granted personal credit is spendable with PERSONAL_CREDIT_ENABLED and no Stripe', async () => {
    const noStripe = {
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      PERSONAL_CREDIT_ENABLED: 'true',
    };
    const { user, credit, e } = await setup({ env: noStripe });
    await json<AdminCreditResponse>(
      await credit({
        target: 'personal',
        userId: user.userId,
        amountCents: 100,
        mode: 'adjustment',
        idempotencyKey: key(),
      }),
    );
    const detail = await json<TreeDetail>(
      await user.client.call(
        '/api/trees',
        { method: 'POST', json: { title: 'T' }, learn: 'credit' },
        e,
      ),
      201,
    );
    const res = await user.client.call(
      `/api/branches/${detail.branches[0]!.id}/messages`,
      { method: 'POST', json: { content: 'Hello' }, learn: 'credit' },
      e,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    await res.text();
    const { results } = await env.DB.prepare(
      `SELECT funding, status, charge_micros FROM usage_events WHERE account_id = ? AND purpose = 'reply'`,
    )
      .bind(`u_${user.userId}`)
      .all<{ funding: string; status: string; charge_micros: number | null }>();
    expect(results).toMatchObject([{ funding: 'personal', status: 'settled' }]);
    expect(results[0]!.charge_micros).toBeGreaterThan(0);
    expect(await balance(`u_${user.userId}`)).toBe(1_000_000 - results[0]!.charge_micros!);
  });
});

describe('GET /api/admin/pool', () => {
  it('reports the pool’s balance, holds and overage breaker, to admins only', async () => {
    const admin = await poolReadyUser({ funds: 0 });
    const user = await poolReadyUser({ poolId: admin.poolId, funds: 0 });
    const poolId = admin.poolId;
    const e = authEnv({
      POOL_ACCOUNT_ID: poolId,
      ADMIN_USER_IDS: admin.userId,
      POOL_OVERAGE_MAX_MICROS: '1000',
    });
    const read = (as = admin) => as.client.call('/api/admin/pool', {}, e);
    await fundPool(poolId, 5_000_000);
    const now = Date.now();
    const usage = (charge: number | null, overage: number, at: number) =>
      env.DB.prepare(
        `INSERT INTO usage_events (id, account_id, funding, purpose, provider_id, model, status,
           hold_micros, markup_bps, fee_bps, charge_micros, overage_micros, created_at)
         VALUES (?, ?, 'pool', 'reply', 'tangent', 'simple', ?, 3000, 0, 0, ?, ?, ?)`,
      ).bind(
        uniq('use'),
        poolId,
        charge === null ? 'pending' : 'settled',
        charge,
        overage,
        new Date(at).toISOString(),
      );
    await env.DB.batch([
      usage(null, 0, now),
      usage(3_000, 600, now - 60_000),
      // Outside the 24 h window: not in the breaker's sum.
      usage(3_000, 5_000, now - 25 * 60 * 60_000),
    ]);

    const report = await json<AdminPoolResponse>(await read());
    expect(report).toEqual({
      enabled: true,
      accountId: poolId,
      balanceMicros: 5_000_000 - 6_000,
      heldMicros: 3_000,
      pendingCalls: 1,
      availableMicros: 5_000_000 - 9_000,
      devPurchasesEnabled: false,
      breaker: { overageMicros: 600, maxMicros: 1_000, windowMs: 24 * 60 * 60_000, tripped: false },
    });

    await usage(3_000, 600, now - 30_000).run();
    expect((await json<AdminPoolResponse>(await read())).breaker).toMatchObject({
      overageMicros: 1_200,
      tripped: true,
    });

    expect((await json<ApiError>(await read(user), 404)).error.code).toBe('not_found');
  });
});
