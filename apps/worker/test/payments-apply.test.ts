// What a successful payment and a membership snapshot do (billing/payments/apply.ts),
// on neutral events: no provider wire format, so a provider switch leaves these as they are.
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPaymentEvent,
  MEMBERSHIP_CREDIT_NOTE,
  RetryLaterError,
} from '../src/billing/payments/apply.js';
import { customerRefFor } from '../src/billing/payments/customers.js';
import { getBalance } from '../src/billing/ledger.js';
import type { AppEnv } from '../src/env.js';
import { grantDetailsFor, insertUser, uniq } from './mocks/billing-helpers.js';
import { membership, membershipPaid, paid } from './mocks/payment-events.js';

const env = rawEnv as unknown as AppEnv;
const noProvider = { provider: null };
const apply = (e: Parameters<typeof applyPaymentEvent>[1], en: AppEnv = env) =>
  applyPaymentEvent(en, e, noProvider);
const balance = async (accountId: string) => (await getBalance(env.DB, accountId)).balanceMicros;

async function newUser(): Promise<string> {
  const id = uniq('user');
  await insertUser(env, { id });
  return id;
}

async function subscriptionRows(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT ref, provider, kind, status, provider_status, current_period_end, cancel_at_period_end,
            ended_at, version FROM billing_subscriptions WHERE user_id = ? ORDER BY ref`,
  )
    .bind(userId)
    .all<Record<string, unknown>>();
  return results;
}

describe('payment.succeeded: credit purchases', () => {
  it('credits a personal top-up once, net of the fee, to the buyer’s ledger', async () => {
    const userId = await newUser();
    const e = paid({ userId, netCents: 1000, feeCents: 80, taxCents: 87 });
    expect(await apply(e)).toBe('applied');
    expect(await apply(e)).toBe('duplicate');
    expect(await grantDetailsFor(env, `u_${userId}`)).toEqual([
      {
        kind: 'purchase',
        amount_micros: 9_200_000,
        gross_micros: 10_000_000,
        fee_micros: 800_000,
        provider_ref: e.paymentRef,
      },
    ]);
  });

  it('credits the ledger the checkout named only when it is a personal one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const userId = await newUser();
    const named = paid({ userId, accountId: `u_${userId}`, netCents: 2000, feeCents: 150 });
    expect(await apply(named)).toBe('applied');
    expect(await balance(`u_${userId}`)).toBe(18_500_000);
    // Nobody buys pool credit: a payment naming the pool's ledger credits nothing.
    const poolId = uniq('pool');
    expect(await apply(paid({ userId, accountId: poolId }))).toBe('skipped');
    expect(await grantDetailsFor(env, poolId)).toEqual([]);
    warn.mockRestore();
  });

  it('asks for a retry while the fee is unknown, and logs an estimated fee', async () => {
    const userId = await newUser();
    const e = paid({ userId, feeCents: null });
    await expect(apply(e)).rejects.toBeInstanceOf(RetryLaterError);
    expect(await balance(`u_${userId}`)).toBe(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await apply({ ...e, fee: { cents: 90, estimated: true } })).toBe('applied');
    expect(warn.mock.calls.some(([m]) => String(m).includes('"fee_estimated"'))).toBe(true);
    warn.mockRestore();
    expect(await balance(`u_${userId}`)).toBe(9_100_000);
  });

  it('never credits another currency, an unknown target or a payment with no account', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const userId = await newUser();
    expect(await apply(paid({ userId, currency: 'eur' }))).toBe('skipped');
    expect(await apply(paid({ userId, target: 'unknown' }))).toBe('skipped');
    expect(await apply(paid({ userId: null, target: 'personal' }))).toBe('skipped');
    expect(await apply(paid({ userId, netCents: 0 }))).toBe('skipped');
    warn.mockRestore();
    expect(await balance(`u_${userId}`)).toBe(0);
  });

  it('remembers the provider’s customer of a known user only', async () => {
    const userId = await newUser();
    await apply(paid({ userId, customerRef: 'cus_1' }));
    expect(await customerRefFor(env.DB, 'fake', userId)).toBe('cus_1');
    await apply(paid({ userId, customerRef: 'cus_2' }));
    expect(await customerRefFor(env.DB, 'fake', userId)).toBe('cus_2');
    const ghost = uniq('user');
    await apply(paid({ userId: ghost, accountId: `u_${ghost}`, customerRef: 'cus_3' }));
    expect(await customerRefFor(env.DB, 'fake', ghost)).toBeNull();
  });
});

describe('payment.succeeded: the membership', () => {
  it('grants the included credit once per paid year, first and renewal', async () => {
    const userId = await newUser();
    const first = membershipPaid(userId);
    const renewal = membershipPaid(userId, { cycle: 'renewal' });
    expect(await apply(first)).toBe('applied');
    expect(await apply(first)).toBe('duplicate');
    expect(await apply(renewal)).toBe('applied');
    expect(await grantDetailsFor(env, `u_${userId}`)).toEqual([
      expect.objectContaining({
        kind: 'subscription',
        amount_micros: 2_000_000,
        gross_micros: null,
      }),
      expect.objectContaining({
        kind: 'subscription',
        amount_micros: 2_000_000,
        gross_micros: null,
      }),
    ]);
    const { results } = await env.DB.prepare('SELECT note FROM credit_grants WHERE account_id = ?')
      .bind(`u_${userId}`)
      .all<{ note: string }>();
    expect(results.every((r) => r.note === MEMBERSHIP_CREDIT_NOTE)).toBe(true);
  });

  it('grants nothing for a free year, or when no credit is included', async () => {
    const userId = await newUser();
    expect(await apply(membershipPaid(userId, { netCents: 0 }))).toBe('skipped');
    expect(
      await apply(membershipPaid(userId), { ...env, MEMBERSHIP_CREDIT_CENTS: '0' } as AppEnv),
    ).toBe('skipped');
    expect(await balance(`u_${userId}`)).toBe(0);
  });
});

describe('membership.changed', () => {
  it('upserts the snapshot, newest version wins, in any order', async () => {
    const userId = await newUser();
    const active = membership(userId, 'active', { version: '2026-10-05T12:00:00.000Z' });
    const ref = active.subscriptionRef;
    const canceling = membership(userId, 'active', {
      subscriptionRef: ref,
      version: '2026-11-01T00:00:00.000Z',
      cancelAtPeriodEnd: true,
    });
    const ended = membership(userId, 'canceled', {
      subscriptionRef: ref,
      version: '2027-10-05T12:00:00.000Z',
    });
    expect(await apply(ended)).toBe('applied');
    // Older snapshots arriving late change nothing.
    expect(await apply(active)).toBe('duplicate');
    expect(await apply(canceling)).toBe('duplicate');
    expect(await subscriptionRows(userId)).toEqual([
      {
        ref,
        provider: 'fake',
        kind: 'membership',
        status: 'canceled',
        provider_status: 'canceled',
        current_period_end: '2027-10-05T12:00:00.000Z',
        cancel_at_period_end: 0,
        ended_at: '2026-10-05T12:00:00.000Z',
        version: '2027-10-05T12:00:00.000Z',
      },
    ]);
  });

  it('records cancel-at-period-end and the customer, and ignores deleted users', async () => {
    const userId = await newUser();
    const e = membership(userId, 'past_due', { cancelAtPeriodEnd: true, customerRef: 'cus_m' });
    expect(await apply(e)).toBe('applied');
    expect(await subscriptionRows(userId)).toMatchObject([
      { status: 'past_due', cancel_at_period_end: 1 },
    ]);
    expect(await customerRefFor(env.DB, 'fake', userId)).toBe('cus_m');
    const ghost = uniq('user');
    expect(await apply(membership(ghost, 'active'))).toBe('duplicate');
    expect(await subscriptionRows(ghost)).toEqual([]);
  });
});
