// The community pool's revenue share (pool/revenue-share.ts): 20% (by
// default) of each membership payment after its fee, taken back in
// proportion by refunds, and of the markup on personal credit as it is used,
// granted once per completed UTC day by the cron, catching up missed days.
import { env as rawEnv } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBalance, grantCredit } from '../src/billing/ledger.js';
import { applyPaymentEvent, RetryLaterError } from '../src/billing/payments/apply.js';
import type { AppEnv } from '../src/env.js';
import { isSupporter } from '../src/pool/supporter.js';
import {
  accruePoolUsageShare,
  membershipShareMicros,
  USAGE_SHARE_CATCH_UP_DAYS,
  usageMarkupBetween,
} from '../src/pool/revenue-share.js';
import { grantDetailsFor, insertUser, uniq } from './mocks/billing-helpers.js';
import { membershipPaid, paid, refunded } from './mocks/payment-events.js';

const env = rawEnv as unknown as AppEnv;
const noProvider = { provider: null };
const balance = async (accountId: string) => (await getBalance(env.DB, accountId)).balanceMicros;

/** An env whose pool is a fresh account, with the deployed 20% share unless told otherwise. */
function shareEnv(overrides: Partial<AppEnv> = {}): { e: AppEnv; poolId: string } {
  const poolId = uniq('pool');
  return {
    e: { ...env, POOL_ACCOUNT_ID: poolId, POOL_REVENUE_SHARE_BPS: '2000', ...overrides } as AppEnv,
    poolId,
  };
}

async function newUser(): Promise<string> {
  const id = uniq('user');
  await insertUser(env, { id });
  return id;
}

describe('membershipShareMicros', () => {
  it('is the share of the pre-tax amount after the fee, rounded down', () => {
    // $10 membership, 80¢ fee: 20% of $9.20.
    expect(membershipShareMicros(1000, 80, 2000)).toBe(1_840_000);
    expect(membershipShareMicros(1000, 80, 0)).toBe(0);
    expect(membershipShareMicros(1000, 1500, 2000)).toBe(0);
    // 1¢ at 33.33%: 3_333 µ$, not 3_333.3.
    expect(membershipShareMicros(1, 0, 3333)).toBe(3_333);
  });
});

describe('membership payments', () => {
  it('add the pool’s share once per payment, first year and renewals, besides the included credit', async () => {
    const { e, poolId } = shareEnv();
    const userId = await newUser();
    const first = membershipPaid(userId, { netCents: 1000 });
    expect(await applyPaymentEvent(e, first, noProvider)).toBe('applied');
    expect(await applyPaymentEvent(e, first, noProvider)).toBe('duplicate');
    const renewal = membershipPaid(userId, { cycle: 'renewal', netCents: 1000 });
    expect(await applyPaymentEvent(e, renewal, noProvider)).toBe('applied');
    // membershipPaid's fee is $1: 20% of $9.00, twice.
    expect(await grantDetailsFor(env, poolId)).toEqual([
      {
        kind: 'contribution',
        amount_micros: 1_800_000,
        gross_micros: 10_000_000,
        fee_micros: 1_000_000,
        provider_ref: `${first.paymentRef}:pool-share`,
      },
      {
        kind: 'contribution',
        amount_micros: 1_800_000,
        gross_micros: 10_000_000,
        fee_micros: 1_000_000,
        provider_ref: `${renewal.paymentRef}:pool-share`,
      },
    ]);
    // The member's included credit, as before; the share makes no one a supporter.
    expect(await balance(`u_${userId}`)).toBe(4_000_000);
    expect(await isSupporter(env.DB, userId, new Date(), null)).toBe(false);
  });

  it('wait for the fee (after the included credit), and add nothing while off or at 0%', async () => {
    const { e, poolId } = shareEnv();
    const userId = await newUser();
    const payment = { ...membershipPaid(userId), fee: null };
    await expect(applyPaymentEvent(e, payment, noProvider)).rejects.toBeInstanceOf(RetryLaterError);
    expect(await balance(`u_${userId}`)).toBe(2_000_000);
    expect(await balance(poolId)).toBe(0);
    const later = { ...payment, fee: { cents: 80, estimated: false } };
    expect(await applyPaymentEvent(e, later, noProvider)).toBe('applied');
    expect(await balance(`u_${userId}`)).toBe(2_000_000);
    expect(await balance(poolId)).toBe(1_840_000);

    for (const overrides of [{ POOL_REVENUE_SHARE_BPS: '0' }, { POOL_ENABLED: 'false' }]) {
      const off = shareEnv(overrides);
      await applyPaymentEvent(off.e, membershipPaid(await newUser()), noProvider);
      expect(await balance(off.poolId)).toBe(0);
    }
    // A credit top-up adds nothing at payment time: its share comes from the markup as it is used.
    const topUp = shareEnv();
    await applyPaymentEvent(topUp.e, paid({ userId: await newUser() }), noProvider);
    expect(await balance(topUp.poolId)).toBe(0);
  });

  it('a refund takes back the same proportion of the share, once per refund, clamped', async () => {
    const { e, poolId } = shareEnv();
    const userId = await newUser();
    const payment = membershipPaid(userId, { netCents: 1000 });
    await applyPaymentEvent(e, payment, noProvider);
    expect(await balance(poolId)).toBe(1_800_000);
    const half = refunded(payment.paymentRef, 500);
    expect(await applyPaymentEvent(e, half, noProvider)).toBe('applied');
    expect(await applyPaymentEvent(e, half, noProvider)).toBe('duplicate');
    expect(await balance(poolId)).toBe(900_000);
    // The pool spent most of it meanwhile: the rest is clamped to what is left.
    await grantCredit(env.DB, {
      accountId: poolId,
      kind: 'adjustment',
      amountMicros: -800_000,
      providerRef: `admin:${uniq('spent')}`,
    });
    const rest = refunded(payment.paymentRef, 500);
    expect(await applyPaymentEvent(e, rest, noProvider)).toBe('applied');
    expect(await balance(poolId)).toBe(0);
    const reversals = (await grantDetailsFor(env, poolId)).filter(
      (g) => g.kind === 'contribution' && g.amount_micros <= 0,
    );
    expect(reversals).toMatchObject([
      {
        amount_micros: -900_000,
        gross_micros: -5_000_000,
        provider_ref: `${half.refundRef}:pool-share`,
      },
      {
        amount_micros: -100_000,
        gross_micros: -5_000_000,
        provider_ref: `${rest.refundRef}:pool-share`,
      },
    ]);
    // Refilled later: the clamped reversal is never taken again.
    await grantCredit(env.DB, {
      accountId: poolId,
      kind: 'adjustment',
      amountMicros: 500_000,
      providerRef: `admin:${uniq('top')}`,
    });
    expect(await applyPaymentEvent(e, rest, noProvider)).toBe('duplicate');
    expect(await balance(poolId)).toBe(500_000);
    // The included credit came back out once, as before.
    expect(await balance(`u_${userId}`)).toBe(0);
  });

  it('refunds take back at most the whole share, however much they add up to', async () => {
    const { e, poolId } = shareEnv();
    const userId = await newUser();
    const payment = membershipPaid(userId, { netCents: 1000 });
    await applyPaymentEvent(e, payment, noProvider);
    await grantCredit(env.DB, {
      accountId: poolId,
      kind: 'adjustment',
      amountMicros: 10_000_000,
      providerRef: `admin:${uniq('top')}`,
    });
    // 60%, then a refund the provider reports as the whole amount: 100% of the share, not 160%.
    await applyPaymentEvent(e, refunded(payment.paymentRef, 600), noProvider);
    await applyPaymentEvent(e, refunded(payment.paymentRef, 1000), noProvider);
    expect(await balance(poolId)).toBe(10_000_000);
  });
});

// ---- The daily share of the markup on personal credit.
//
// Days in 2003, far from every other suite's rows (they settle "now"); each
// test uses its own days, and the usage share refs (written by this suite
// only) are cleared before each test.

const DAY_MS = 24 * 60 * 60_000;

async function usage(o: {
  settledAt: string | null;
  chargeMicros: number;
  markupBps?: number;
  funding?: 'personal' | 'pool';
  status?: 'settled' | 'pending' | 'unresolved';
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage_events (id, account_id, funding, purpose, provider_id, model, status,
       hold_micros, markup_bps, fee_bps, charge_micros, created_at, settled_at)
     VALUES (?, ?, ?, 'reply', 'tangent', 'simple', ?, 20000, ?, 550, ?, ?, ?)`,
  )
    .bind(
      uniq('use'),
      o.funding === 'pool' ? uniq('pool') : `u_${uniq('user')}`,
      o.funding ?? 'personal',
      o.status ?? 'settled',
      o.markupBps ?? 1000,
      o.chargeMicros,
      o.settledAt ?? '2003-01-01T00:00:00.000Z',
      o.settledAt,
    )
    .run();
}

async function usageShares(poolId: string) {
  const { results } = await env.DB.prepare(
    `SELECT provider_ref, amount_micros, gross_micros FROM credit_grants
     WHERE account_id = ? AND kind = 'contribution' ORDER BY provider_ref`,
  )
    .bind(poolId)
    .all<{ provider_ref: string; amount_micros: number; gross_micros: number }>();
  return results;
}

describe('the daily share of the markup', () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `DELETE FROM credit_grants WHERE provider_ref >= 'pool-share:usage:' AND provider_ref < 'pool-share:usage;'`,
    ).run();
  });

  it('sums only the markup of personal charges settled that UTC day, rounded down', async () => {
    // $1.10 charged at +10%: $0.10 of markup. $1.05 at +5%: $0.05.
    await usage({ settledAt: '2003-02-10T00:00:00.000Z', chargeMicros: 1_100_000 });
    await usage({ settledAt: '2003-02-10T12:00:00.000Z', chargeMicros: 1_050_000, markupBps: 500 });
    await usage({ settledAt: '2003-02-10T23:59:59.999Z', chargeMicros: 11 });
    // Not counted: the pool (at cost), no markup, pending or unresolved, and the next day.
    await usage({ settledAt: '2003-02-10T12:00:00.000Z', chargeMicros: 900_000, funding: 'pool' });
    await usage({ settledAt: '2003-02-10T12:00:00.000Z', chargeMicros: 900_000, markupBps: 0 });
    await usage({ settledAt: null, chargeMicros: 900_000, status: 'pending' });
    await usage({ settledAt: '2003-02-10T12:00:00.000Z', chargeMicros: 0, status: 'unresolved' });
    await usage({ settledAt: '2003-02-11T00:00:00.000Z', chargeMicros: 1_100_000 });
    expect(
      await usageMarkupBetween(
        env.DB,
        '2003-02-10T00:00:00.000Z',
        '2003-02-11T00:00:00.000Z',
        2000,
      ),
    ).toEqual({
      // 100_000 + 50_000 + floor(11 / 11) = 150_001; 20%: 20_000 + 10_000 + 0.
      markupMicros: 150_001,
      shareMicros: 30_000,
    });
  });

  it('grants each completed day once, after a grace period, and is idempotent', async () => {
    const { e, poolId } = shareEnv();
    await usage({ settledAt: '2003-03-10T08:00:00.000Z', chargeMicros: 11_000_000 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // The first run ever starts at yesterday: the 9th, with nothing to share.
    expect(await accruePoolUsageShare(e, new Date('2003-03-10T12:00:00.000Z'))).toEqual({
      days: ['2003-03-09'],
      addedMicros: 0,
    });
    // 00:10 on the 11th: the 10th has only just ended; nothing yet.
    expect(await accruePoolUsageShare(e, new Date('2003-03-11T00:10:00.000Z'))).toEqual({
      days: [],
      addedMicros: 0,
    });
    // 00:20: the 10th is shared.
    expect(await accruePoolUsageShare(e, new Date('2003-03-11T00:20:00.000Z'))).toEqual({
      days: ['2003-03-10'],
      addedMicros: 200_000,
    });
    expect(await accruePoolUsageShare(e, new Date('2003-03-11T09:00:00.000Z'))).toEqual({
      days: [],
      addedMicros: 0,
    });
    log.mockRestore();
    expect(await usageShares(poolId)).toEqual([
      { provider_ref: 'pool-share:usage:2003-03-09', amount_micros: 0, gross_micros: 0 },
      {
        provider_ref: 'pool-share:usage:2003-03-10',
        amount_micros: 200_000,
        gross_micros: 1_000_000,
      },
    ]);
    expect(await balance(poolId)).toBe(200_000);
  });

  it('catches up the days it missed, writing 0 for days with no markup', async () => {
    const { e, poolId } = shareEnv();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await usage({ settledAt: '2003-04-01T10:00:00.000Z', chargeMicros: 1_100_000 });
    await accruePoolUsageShare(e, new Date('2003-04-02T01:00:00.000Z'));
    await usage({ settledAt: '2003-04-02T10:00:00.000Z', chargeMicros: 2_200_000 });
    await usage({ settledAt: '2003-04-04T23:00:00.000Z', chargeMicros: 3_300_000 });
    // The cron was down for three days.
    expect(await accruePoolUsageShare(e, new Date('2003-04-05T06:00:00.000Z'))).toEqual({
      days: ['2003-04-02', '2003-04-03', '2003-04-04'],
      addedMicros: 40_000 + 0 + 60_000,
    });
    log.mockRestore();
    expect((await usageShares(poolId)).map((r) => [r.provider_ref, r.amount_micros])).toEqual([
      ['pool-share:usage:2003-04-01', 20_000],
      ['pool-share:usage:2003-04-02', 40_000],
      ['pool-share:usage:2003-04-03', 0],
      ['pool-share:usage:2003-04-04', 60_000],
    ]);
  });

  it('catches up at most USAGE_SHARE_CATCH_UP_DAYS, and nothing while off or at 0%', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const off = shareEnv({ POOL_REVENUE_SHARE_BPS: '0' });
    await usage({ settledAt: '2003-05-01T10:00:00.000Z', chargeMicros: 1_100_000 });
    // The day is decided at 0 (a 0 row), so it is never shared later.
    expect(await accruePoolUsageShare(off.e, new Date('2003-05-02T01:00:00.000Z'))).toEqual({
      days: ['2003-05-01'],
      addedMicros: 0,
    });
    expect(await balance(off.poolId)).toBe(0);
    const disabled = shareEnv({ POOL_ENABLED: 'false' });
    expect(await accruePoolUsageShare(disabled.e, new Date('2003-05-03T01:00:00.000Z'))).toEqual({
      days: ['2003-05-02'],
      addedMicros: 0,
    });
    expect(await balance(disabled.poolId)).toBe(0);

    const { e } = shareEnv();
    await accruePoolUsageShare(e, new Date('2003-05-02T01:00:00.000Z'));
    const later = new Date(Date.parse('2003-05-02T01:00:00.000Z') + 60 * DAY_MS);
    const { days } = await accruePoolUsageShare(e, later);
    expect(days).toHaveLength(USAGE_SHARE_CATCH_UP_DAYS);
    expect(days.at(-1)).toBe('2003-06-30');
    expect(days[0]).toBe('2003-05-31');
    log.mockRestore();
  });

  it('never back-fills the days the pool was off or the share was 0', async () => {
    const { e, poolId } = shareEnv();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await usage({ settledAt: '2003-08-01T10:00:00.000Z', chargeMicros: 1_100_000 });
    await accruePoolUsageShare(e, new Date('2003-08-02T01:00:00.000Z'));
    // Off from the 2nd through the 4th (the cron keeps running), with markup each day.
    for (const day of ['02', '03', '04'])
      await usage({ settledAt: `2003-08-${day}T10:00:00.000Z`, chargeMicros: 1_100_000 });
    const off = { ...e, POOL_ENABLED: 'false' } as AppEnv;
    await accruePoolUsageShare(off, new Date('2003-08-03T01:00:00.000Z'));
    await accruePoolUsageShare(
      { ...e, POOL_REVENUE_SHARE_BPS: '0' } as AppEnv,
      new Date('2003-08-05T01:00:00.000Z'),
    );
    // Back on: only the days from now on accrue.
    await usage({ settledAt: '2003-08-05T10:00:00.000Z', chargeMicros: 1_100_000 });
    expect(await accruePoolUsageShare(e, new Date('2003-08-06T01:00:00.000Z'))).toEqual({
      days: ['2003-08-05'],
      addedMicros: 20_000,
    });
    log.mockRestore();
    expect(await balance(poolId)).toBe(40_000);
    expect((await usageShares(poolId)).map((r) => [r.provider_ref, r.amount_micros])).toEqual([
      ['pool-share:usage:2003-08-01', 20_000],
      ['pool-share:usage:2003-08-02', 0],
      ['pool-share:usage:2003-08-03', 0],
      ['pool-share:usage:2003-08-04', 0],
      ['pool-share:usage:2003-08-05', 20_000],
    ]);
  });

  it('works through the $10 top-up example: $0.17 of the ≈$0.84 markup on $9.20 of credit', async () => {
    const { e, poolId } = shareEnv();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // A $10 top-up with an 80¢ fee adds $9.20 of credit; spent in full at +10%, that is
    // $9.20 / 1.1 ≈ $8.36 of cost and ≈ $0.84 of markup, of which 20% goes to the pool.
    await usage({ settledAt: '2003-07-01T10:00:00.000Z', chargeMicros: 9_200_000 });
    expect(await accruePoolUsageShare(e, new Date('2003-07-02T01:00:00.000Z'))).toEqual({
      days: ['2003-07-01'],
      addedMicros: 167_272,
    });
    log.mockRestore();
    expect((await usageShares(poolId))[0]).toMatchObject({ gross_micros: 836_363 });
  });
});
