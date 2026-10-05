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
import { disputed, fakeRef, factsOf, membershipPaid, paid } from './mocks/payment-events.js';
import { poolAccess } from './pool-helpers.js';

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
    const payment = paid({
      userId,
      target: 'pool',
      accountId: poolId,
      netCents: 1000,
      feeCents: 80,
    });
    await apply(payment);
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

  it('does nothing without a polled dispute source', async () => {
    expect(await pollDisputes(env, new Date(), createFakeProvider())).toEqual({
      polled: false,
      applied: 0,
      failed: 0,
    });
    expect(await pollDisputes(env, new Date(), null)).toMatchObject({ polled: false });
  });
});
