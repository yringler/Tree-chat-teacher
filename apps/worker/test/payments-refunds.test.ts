// Refunds of payments (billing/payments/apply.ts) on neutral events: personal
// purchases, pool purchases (clamped by PoolBank), the membership's included
// credit, and refunds that arrive before (or without) their payment.
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { applyPaymentEvent, RetryLaterError } from '../src/billing/payments/apply.js';
import { getBalance } from '../src/billing/ledger.js';
import { createFakeProvider } from '../src/billing/providers/fake.js';
import type { AppEnv } from '../src/env.js';
import { isSupporter } from '../src/pool/supporter.js';
import { grantDetailsFor, insertUsage, insertUser, uniq } from './mocks/billing-helpers.js';
import { factsOf, fakeRef, membershipPaid, paid, refunded } from './mocks/payment-events.js';
import { fundPool } from './pool-helpers.js';

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
    // Refunded in full: no longer a supporter.
    expect(await isSupporter(env.DB, userId, new Date(), null)).toBe(false);
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

describe('refund.succeeded: pool purchases', () => {
  it('takes back the share of what the purchase credited, clamped to what the pool has', async () => {
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
    // Half refunded: half of the 9.20 it added.
    expect(await apply(refunded(payment.paymentRef, 500))).toBe('applied');
    expect(await balance(poolId)).toBe(4_600_000);
    // The pool spends the rest; the next refund finds nothing to take.
    await insertUsage(env, { accountId: poolId, status: 'settled', chargeMicros: 4_600_000 });
    const rest = refunded(payment.paymentRef, 500);
    expect(await apply(rest)).toBe('applied');
    const rows = (await grantDetailsFor(env, poolId)).filter((g) => g.kind === 'refund');
    expect(rows).toMatchObject([
      { amount_micros: -4_600_000, gross_micros: -5_000_000 },
      { amount_micros: 0, gross_micros: -5_000_000, provider_ref: rest.refundRef },
    ]);
    // Refilled later: the clamped refund is never debited again.
    await fundPool(poolId, 3_000_000);
    expect(await apply(rest)).toBe('duplicate');
    expect(await balance(poolId)).toBe(3_000_000);
  });
});

describe('refund.succeeded: the membership', () => {
  it('takes the included credit back once, however many refunds the payment gets', async () => {
    const userId = await newUser();
    const payment = membershipPaid(userId);
    await apply(payment);
    expect(await apply(refunded(payment.paymentRef, 300))).toBe('applied');
    expect(await apply(refunded(payment.paymentRef, 700))).toBe('duplicate');
    expect(await balance(`u_${userId}`)).toBe(0);
    expect((await grantDetailsFor(env, `u_${userId}`))[1]).toMatchObject({
      kind: 'refund',
      amount_micros: -2_000_000,
      provider_ref: `${payment.paymentRef}:membership-refund`,
    });
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

  it('does nothing for a payment that granted nothing, or one the provider doesn’t know', async () => {
    const userId = await newUser();
    const free = membershipPaid(userId);
    const provider = createFakeProvider({ payments: [factsOf(free)] });
    expect(await applyPaymentEvent(env, refunded(free.paymentRef, 1000), { provider })).toBe(
      'skipped',
    );
    expect(await applyPaymentEvent(env, refunded(fakeRef('order'), 1000), { provider })).toBe(
      'skipped',
    );
    expect(await apply(refunded(fakeRef('order'), 1000))).toBe('skipped');
    expect(await balance(`u_${userId}`)).toBe(0);
  });
});
