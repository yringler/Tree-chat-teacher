// Disputes (billing/payments/apply.ts) on neutral events, and the cron's
// dispute poller (billing/payments/disputes.ts) against the fake provider.
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { applyPaymentEvent } from '../src/billing/payments/apply.js';
import { pollDisputes } from '../src/billing/payments/disputes.js';
import { getBalance, grantCredit } from '../src/billing/ledger.js';
import { createFakeProvider } from '../src/billing/providers/fake.js';
import type { AppEnv } from '../src/env.js';
import { grantDetailsFor, insertUser, uniq } from './mocks/billing-helpers.js';
import {
  disputed,
  fakeRef,
  factsOf,
  membershipPaid,
  paid,
  refunded,
} from './mocks/payment-events.js';
import { poolAccess } from './pool-helpers.js';

const env = rawEnv as unknown as AppEnv;
const noProvider = { provider: null };
const apply = (e: Parameters<typeof applyPaymentEvent>[1]) => applyPaymentEvent(env, e, noProvider);
const balance = async (accountId: string) => (await getBalance(env.DB, accountId)).balanceMicros;

/** The dispute's markers (`billing_markers`) and any ledger row naming it beyond its debit. */
async function markersOf(disputeRef: string) {
  const markers = await env.DB.prepare(
    "SELECT ref FROM billing_markers WHERE ref LIKE ?1 || ':%' ORDER BY ref",
  )
    .bind(disputeRef)
    .all<{ ref: string }>();
  const grants = await env.DB.prepare(
    "SELECT provider_ref FROM credit_grants WHERE provider_ref LIKE ?1 || ':%'",
  )
    .bind(disputeRef)
    .all<{ provider_ref: string }>();
  return { markers: markers.results.map((r) => r.ref), grants: grants.results };
}

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
    const payment = paid({ userId, netCents: 1000, feeCents: 80 });
    await apply(payment);
    const lost = disputed('dispute.lost', payment.paymentRef, 1000);
    expect(await apply(lost)).toBe('applied');
    expect(
      (await grantDetailsFor(env, `u_${userId}`)).find((g) => g.provider_ref === lost.disputeRef),
    ).toMatchObject({ kind: 'refund', amount_micros: -10_000_000, gross_micros: -10_000_000 });
    expect((await poolAccess(userId))?.pool_suspended).toBe(1);
    // An admin lifts the suspension; the poller keeps seeing the dispute as lost.
    await env.DB.prepare('UPDATE auth_users SET pool_suspended = 0 WHERE id = ?')
      .bind(userId)
      .run();
    expect(await apply(lost)).toBe('duplicate');
    expect((await poolAccess(userId))?.pool_suspended).toBe(0);
    expect(await balance(`u_${userId}`)).toBe(-800_000);
    // The suspension is remembered as a marker, not as a zero-amount ledger row.
    expect(await markersOf(lost.disputeRef)).toEqual({
      markers: [`${lost.disputeRef}:lost`],
      grants: [],
    });
    warn.mockRestore();
  });

  it('leaves membership disputes to the operator, and ignores a won dispute never debited', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const userId = await newUser();
    const payment = membershipPaid(userId);
    await apply(payment);
    const opened = disputed('dispute.opened', payment.paymentRef, 1000);
    expect(await apply(opened)).toBe('skipped');
    expect(await apply(opened)).toBe('duplicate');
    expect(await apply(disputed('dispute.won', payment.paymentRef, 1000))).toBe('skipped');
    expect(await balance(`u_${userId}`)).toBe(0);
    expect(await markersOf(opened.disputeRef)).toEqual({
      markers: [`${opened.disputeRef}:ignored`],
      grants: [],
    });
    warn.mockRestore();
  });

  it('leaves a purchase on a ledger that is not a user’s (the pool’s) alone, and logs it once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const poolId = uniq('pool');
    const paymentRef = fakeRef('order');
    await grantCredit(env.DB, {
      accountId: poolId,
      kind: 'purchase',
      amountMicros: 9_200_000,
      grossMicros: 10_000_000,
      providerRef: paymentRef,
    });
    const lost = disputed('dispute.lost', paymentRef, 1000);
    expect(await apply(lost)).toBe('skipped');
    expect(await apply(lost)).toBe('duplicate');
    const logged = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);
    warn.mockRestore();
    expect(logged).toEqual([
      expect.objectContaining({
        event: 'dispute_not_debited',
        reason: 'not_a_user_ledger',
        disputeRef: lost.disputeRef,
        paymentRef,
        accountId: poolId,
      }),
    ]);
    expect(await balance(poolId)).toBe(9_200_000);
    expect(await markersOf(lost.disputeRef)).toEqual({
      markers: [`${lost.disputeRef}:ignored`],
      grants: [],
    });
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
    await apply(paid({ userId, netCents: 500, feeCents: 0 }));
    // Won: it took nothing, so it gives nothing back.
    const lateWon = disputed('dispute.won', a.paymentRef, 1000, lateDispute.disputeRef);
    expect(await apply(lateWon)).toBe('applied');
    expect(await balance(`u_${userId}`)).toBe(4_200_000);

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
    // A membership payment (left to the operator) and an order that granted nothing.
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
    expect(getPayment).toHaveBeenCalledTimes(2);
    const notDebited = () =>
      warn.mock.calls.filter((c) => String(c[0]).includes('dispute_not_debited')).length;
    expect(notDebited()).toBe(2);
    for (let i = 0; i < 3; i++)
      expect(await pollDisputes(env, new Date(), provider)).toMatchObject({
        applied: 0,
        failed: 0,
      });
    expect(getPayment).toHaveBeenCalledTimes(2);
    expect(notDebited()).toBe(2);
    warn.mockRestore();
    expect(await balance(`u_${userId}`)).toBe(0);
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
