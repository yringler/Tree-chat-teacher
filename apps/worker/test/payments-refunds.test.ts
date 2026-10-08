// Refunds of payments (billing/payments/apply.ts) on neutral events: personal
// purchases, membership payments (nothing to take back), and refunds that
// arrive before (or without) their payment.
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { applyPaymentEvent, RetryLaterError } from '../src/billing/payments/apply.js';
import { getBalance } from '../src/billing/ledger.js';
import { createFakeProvider } from '../src/billing/providers/fake.js';
import type { AppEnv } from '../src/env.js';
import { grantDetailsFor, insertUser, uniq } from './mocks/billing-helpers.js';
import { factsOf, fakeRef, membershipPaid, paid, refunded } from './mocks/payment-events.js';

const env = rawEnv as unknown as AppEnv;
const noProvider = { provider: null };
const apply = (e: Parameters<typeof applyPaymentEvent>[1]) => applyPaymentEvent(env, e, noProvider);
const balance = async (accountId: string) => (await getBalance(env.DB, accountId)).balanceMicros;

async function newUser(): Promise<string> {
  const id = uniq('user');
  await insertUser(env, { id });
  return id;
}

describe('refund.succeeded: personal purchases', () => {
  it('debits the refunded pre-tax amount in full, once per refund', async () => {
    const userId = await newUser();
    const payment = paid({ userId, netCents: 1000, feeCents: 80 });
    await apply(payment);
    const partial = refunded(payment.paymentRef, 400);
    expect(await apply(partial)).toBe('applied');
    expect(await apply(partial)).toBe('duplicate');
    expect(await apply(refunded(payment.paymentRef, 600))).toBe('applied');
    // Credited 9.20 (net of the fee), refunded 10.00: the fee is the user's to bear.
    expect(await balance(`u_${userId}`)).toBe(-800_000);
    expect((await grantDetailsFor(env, `u_${userId}`)).slice(1)).toMatchObject([
      { kind: 'refund', amount_micros: -4_000_000, gross_micros: -4_000_000 },
      { kind: 'refund', amount_micros: -6_000_000, gross_micros: -6_000_000 },
    ]);
  });

  it('ignores refunds in another currency', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const userId = await newUser();
    const payment = paid({ userId });
    await apply(payment);
    expect(await apply(refunded(payment.paymentRef, 1000, { currency: 'eur' }))).toBe('skipped');
    warn.mockRestore();
    expect(await balance(`u_${userId}`)).toBe(9_200_000);
  });
});

describe('refund.succeeded before (or without) its payment', () => {
  it('retries while the payment is a credits purchase not credited yet', async () => {
    const userId = await newUser();
    const payment = paid({ userId });
    const provider = createFakeProvider({ payments: [factsOf(payment)] });
    const refund = refunded(payment.paymentRef, 1000);
    await expect(applyPaymentEvent(env, refund, { provider })).rejects.toBeInstanceOf(
      RetryLaterError,
    );
    await apply(payment);
    expect(await applyPaymentEvent(env, refund, { provider })).toBe('applied');
    expect(await balance(`u_${userId}`)).toBe(-800_000);
  });

  it('acknowledges a refund of a credits payment that was never credited, and never will be', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const userId = await newUser();
    // Each is skipped when paid (no user, another currency, nothing paid), so its
    // refund must not wait for it.
    const skipped = [
      paid({ userId: null }),
      paid({ userId, currency: 'eur' }),
      paid({ userId, netCents: 0 }),
    ];
    const provider = createFakeProvider({ payments: skipped.map(factsOf) });
    for (const payment of skipped) {
      expect(await applyPaymentEvent(env, payment, { provider })).toBe('skipped');
      const refund = refunded(payment.paymentRef, 1000);
      expect(await applyPaymentEvent(env, refund, { provider })).toBe('skipped');
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refund_not_debited'));
    warn.mockRestore();
    expect(await balance(`u_${userId}`)).toBe(0);
  });

  it('never waits for a membership payment: it grants nothing', async () => {
    const userId = await newUser();
    const payment = membershipPaid(userId, { netCents: 1000 });
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = createFakeProvider({ payments: [factsOf(payment)] });
    expect(await applyPaymentEvent(env, refunded(payment.paymentRef, 1000), { provider })).toBe(
      'skipped',
    );
    expect(await applyPaymentEvent(env, payment, { provider })).toBe('skipped');
    expect(await applyPaymentEvent(env, refunded(payment.paymentRef, 1000), { provider })).toBe(
      'skipped',
    );
    quiet.mockRestore();
    expect(await balance(`u_${userId}`)).toBe(0);
  });

  it('does nothing for a payment that granted nothing, or one the provider doesn’t know', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const userId = await newUser();
    // A membership payment naming no user: nothing to wait for.
    const free = membershipPaid(null);
    const provider = createFakeProvider({ payments: [factsOf(free)] });
    expect(await applyPaymentEvent(env, refunded(free.paymentRef, 1000), { provider })).toBe(
      'skipped',
    );
    expect(await applyPaymentEvent(env, refunded(fakeRef('order'), 1000), { provider })).toBe(
      'skipped',
    );
    expect(await apply(refunded(fakeRef('order'), 1000))).toBe('skipped');
    warn.mockRestore();
    expect(await balance(`u_${userId}`)).toBe(0);
  });
});
