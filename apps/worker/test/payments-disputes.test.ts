// Disputes (billing/payments/apply.ts) on neutral events, and the cron's
// dispute poller (billing/payments/disputes.ts) against the fake provider.
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { applyPaymentEvent } from '../src/billing/payments/apply.js';
import { pollDisputes } from '../src/billing/payments/disputes.js';
import { getBalance } from '../src/billing/ledger.js';
import { createFakeProvider } from '../src/billing/providers/fake.js';
import type { AppEnv } from '../src/env.js';
import { grantDetailsFor, insertUsage, insertUser, uniq } from './mocks/billing-helpers.js';
import {
  disputed,
  fakeRef,
  factsOf,
  legacyPoolPurchase,
  membershipPaid,
  paid,
  refunded,
} from './mocks/payment-events.js';
import { isSupporter } from '../src/pool/supporter.js';
import { fundPool, poolAccess } from './pool-helpers.js';

const env = rawEnv as unknown as AppEnv;
const noProvider = { provider: null };
const apply = (e: Parameters<typeof applyPaymentEvent>[1]) => applyPaymentEvent(env, e, noProvider);
const balance = async (accountId: string) => (await getBalance(env.DB, accountId)).balanceMicros;

async function newUser(): Promise<string> {
  const id = uniq('user');
  await insertUser(env, { id });
  return id;
}

describe('disputes', () => {
  it('debits a disputed top-up once and credits it back once when won', async () => {
    const userId = await newUser();
    const payment = paid({ userId, netCents: 1000, feeCents: 80 });
    await apply(payment);
    const ref = fakeRef('dispute');
    const opened = disputed('dispute.opened', payment.paymentRef, 1000, ref);
    expect(await apply(opened)).toBe('applied');
    expect(await apply(opened)).toBe('duplicate');
    expect(await balance(`u_${userId}`)).toBe(-800_000);
    const won = disputed('dispute.won', payment.paymentRef, 1000, ref);
    expect(await apply(won)).toBe('applied');
    expect(await apply(won)).toBe('duplicate');
    expect(await balance(`u_${userId}`)).toBe(9_200_000);
    expect((await poolAccess(userId))?.pool_suspended).toBe(0);
  });

  it('a dispute first seen as lost debits once and suspends the buyer once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const userId = await newUser();
    const poolId = uniq('pool');
    const payment = await legacyPoolPurchase(env, { poolId, userId, netCents: 1000, feeCents: 80 });
    await insertUsage(env, { accountId: poolId, status: 'settled', chargeMicros: 9_000_000 });
    const lost = disputed('dispute.lost', payment.paymentRef, 1000);
    expect(await apply(lost)).toBe('applied');
    // Clamped: the pool had only 0.20 left.
    expect(
      (await grantDetailsFor(env, poolId)).find((g) => g.provider_ref === lost.disputeRef),
    ).toMatchObject({ kind: 'refund', amount_micros: -200_000, gross_micros: -10_000_000 });
    expect((await poolAccess(userId))?.pool_suspended).toBe(1);
    // An admin lifts the suspension; the poller keeps seeing the dispute as lost.
    await env.DB.prepare('UPDATE auth_users SET pool_suspended = 0 WHERE id = ?')
      .bind(userId)
      .run();
    expect(await apply(lost)).toBe('duplicate');
    expect((await poolAccess(userId))?.pool_suspended).toBe(0);
    expect(await balance(poolId)).toBe(0);
    warn.mockRestore();
  });

  it('leaves membership disputes to the operator, and ignores a won dispute never debited', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const userId = await newUser();
    const payment = membershipPaid(userId);
    await apply(payment);
    expect(await apply(disputed('dispute.opened', payment.paymentRef, 1000))).toBe('skipped');
    expect(await apply(disputed('dispute.won', payment.paymentRef, 1000))).toBe('skipped');
    expect(await balance(`u_${userId}`)).toBe(2_000_000);
    warn.mockRestore();
  });
});

describe('refunds and disputes of the same purchase', () => {
  it('take back at most what the purchase paid, together, in either order', async () => {
    const userId = await newUser();
    // Refunded in full, then disputed: the dispute finds nothing left to take.
    const a = paid({ userId, netCents: 1000, feeCents: 80 });
    await apply(a);
    await apply(refunded(a.paymentRef, 1000));
    const lateDispute = disputed('dispute.opened', a.paymentRef, 1000);
    expect(await apply(lateDispute)).toBe('applied');
    expect(await balance(`u_${userId}`)).toBe(-800_000);
    // Net purchases count what was taken back, not what was asked: $5 more makes a supporter.
    await apply(paid({ userId, netCents: 500, feeCents: 0 }));
    expect(await isSupporter(env.DB, userId, new Date(), null)).toBe(true);
    // Won: it took nothing, so it gives nothing back.
    const lateWon = disputed('dispute.won', a.paymentRef, 1000, lateDispute.disputeRef);
    expect(await apply(lateWon)).toBe('applied');
    expect(await balance(`u_${userId}`)).toBe(4_200_000);
    expect(await isSupporter(env.DB, userId, new Date(), null)).toBe(true);

    // Disputed, then 40% refunded (nothing more to take), then the dispute is won:
    // the refund's $4 stays taken.
    const other = await newUser();
    const b = paid({ userId: other, netCents: 1000, feeCents: 80 });
    await apply(b);
    const ref = fakeRef('dispute');
    await apply(disputed('dispute.opened', b.paymentRef, 1000, ref));
    await apply(refunded(b.paymentRef, 400));
    expect(await balance(`u_${other}`)).toBe(-800_000);
    await apply(disputed('dispute.won', b.paymentRef, 1000, ref));
    expect(await balance(`u_${other}`)).toBe(5_200_000);
    // Replays change nothing.
    await apply(disputed('dispute.won', b.paymentRef, 1000, ref));
    await apply(disputed('dispute.opened', b.paymentRef, 1000, ref));
    expect(await balance(`u_${other}`)).toBe(5_200_000);
    expect(await isSupporter(env.DB, other, new Date(), null)).toBe(true);
  });

  it('take back at most what a legacy pool purchase credited', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const userId = await newUser();
    const poolId = uniq('pool');
    await fundPool(poolId, 50_000_000);
    const payment = await legacyPoolPurchase(env, { poolId, userId, netCents: 1000, feeCents: 80 });
    await apply(refunded(payment.paymentRef, 1000));
    await apply(disputed('dispute.lost', payment.paymentRef, 1000));
    // 50 + 9.20 credited − 9.20 taken back, once.
    expect(await balance(poolId)).toBe(50_000_000);
    warn.mockRestore();
  });
});

describe('pollDisputes', () => {
  it('applies each polled dispute, and a second poll is a no-op', async () => {
    const userId = await newUser();
    const payment = paid({ userId, netCents: 1000, feeCents: 80 });
    await apply(payment);
    const provider = createFakeProvider({
      disputes: [disputed('dispute.opened', payment.paymentRef, 1000)],
    });
    expect(await pollDisputes(env, new Date(), provider)).toEqual({
      polled: true,
      applied: 1,
      failed: 0,
    });
    expect(await pollDisputes(env, new Date(), provider)).toEqual({
      polled: true,
      applied: 0,
      failed: 0,
    });
    expect(await balance(`u_${userId}`)).toBe(-800_000);
  });

  it('logs a dispute that can’t be applied yet and goes on with the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const userId = await newUser();
    const early = paid({ userId });
    const credited = paid({ userId });
    await apply(credited);
    const provider = createFakeProvider({
      payments: [factsOf(early)],
      disputes: [
        disputed('dispute.opened', early.paymentRef, 1000),
        disputed('dispute.opened', credited.paymentRef, 500),
      ],
    });
    expect(await pollDisputes(env, new Date(), provider)).toEqual({
      polled: true,
      applied: 1,
      failed: 1,
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('dispute_poll_apply_failed'));
    error.mockRestore();
  });

  it('looks up and logs a dispute that will never be debited once, not on every poll', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const userId = await newUser();
    // A membership payment (credit granted, left to the operator) and an order that granted nothing.
    const member = membershipPaid(userId);
    await apply(member);
    const other = { ...paid({ userId: null }), purpose: { kind: 'other' as const } };
    const provider = createFakeProvider({
      payments: [factsOf(other)],
      disputes: [
        disputed('dispute.opened', member.paymentRef, 1000),
        disputed('dispute.lost', other.paymentRef, 1000),
      ],
    });
    const getPayment = vi.spyOn(provider, 'getPayment');
    expect(await pollDisputes(env, new Date(), provider)).toMatchObject({ applied: 0, failed: 0 });
    expect(getPayment).toHaveBeenCalledTimes(1);
    const notDebited = () =>
      warn.mock.calls.filter((c) => String(c[0]).includes('dispute_not_debited')).length;
    expect(notDebited()).toBe(2);
    for (let i = 0; i < 3; i++)
      expect(await pollDisputes(env, new Date(), provider)).toMatchObject({
        applied: 0,
        failed: 0,
      });
    expect(getPayment).toHaveBeenCalledTimes(1);
    expect(notDebited()).toBe(2);
    warn.mockRestore();
    expect(await balance(`u_${userId}`)).toBe(2_000_000);
  });

  it('does nothing without a polled dispute source', async () => {
    expect(await pollDisputes(env, new Date(), createFakeProvider())).toEqual({
      polled: false,
      applied: 0,
      failed: 0,
    });
    expect(await pollDisputes(env, new Date(), null)).toMatchObject({ polled: false });
  });
});
