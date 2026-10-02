import { DomainError, PaymentRequiredError, ValidationError } from '@tangent/core';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { getBalance, grantCredit, hasGrant } from '../src/billing/ledger.js';
import { assertCanSpend, getBillingSummary, listUsage, markupFor } from '../src/billing/service.js';
import { billingConfigured, stripePlans } from '../src/billing/stripe.js';
import type { AccountContext, AppEnv } from '../src/env.js';
import { insertSubscription, insertUsage, simpleAccount, uniq } from './mocks/billing-helpers.js';

const env = rawEnv as unknown as AppEnv;

describe('ledger', () => {
  it('starts at zero', async () => {
    expect(await getBalance(env.DB, uniq('acct'))).toEqual({ balanceMicros: 0, heldMicros: 0 });
  });

  it('grants are idempotent on the Stripe ref', async () => {
    const accountId = uniq('acct');
    const ref = uniq('cs');
    const g = { accountId, kind: 'purchase' as const, amountMicros: 5_000_000, stripeRef: ref };
    expect(await hasGrant(env.DB, ref)).toBe(false);
    expect(await grantCredit(env.DB, g)).toBe(true);
    expect(await hasGrant(env.DB, ref)).toBe(true);
    expect(await grantCredit(env.DB, g)).toBe(false);
    expect(await grantCredit(env.DB, { ...g, amountMicros: 9 })).toBe(false);
    expect((await getBalance(env.DB, accountId)).balanceMicros).toBe(5_000_000);
  });

  it('manual adjustments (no ref) always apply', async () => {
    const accountId = uniq('acct');
    const g = {
      accountId,
      kind: 'adjustment' as const,
      amountMicros: 1_000,
      stripeRef: null,
      note: 'goodwill',
    };
    expect(await grantCredit(env.DB, g)).toBe(true);
    expect(await grantCredit(env.DB, g)).toBe(true);
    expect((await getBalance(env.DB, accountId)).balanceMicros).toBe(2_000);
  });

  it('balance = Σ grants − Σ settled charges; held = Σ pending holds', async () => {
    const accountId = uniq('acct');
    await grantCredit(env.DB, {
      accountId,
      kind: 'purchase',
      amountMicros: 10_000_000,
      stripeRef: uniq('cs'),
    });
    await grantCredit(env.DB, {
      accountId,
      kind: 'refund',
      amountMicros: -2_000_000,
      stripeRef: uniq('re'),
    });
    await insertUsage(env, { accountId, status: 'settled', chargeMicros: 1358 });
    await insertUsage(env, { accountId, status: 'settled', chargeMicros: 642 });
    await insertUsage(env, { accountId, status: 'unresolved', chargeMicros: 0 });
    await insertUsage(env, { accountId, status: 'pending', holdMicros: 20_000 });
    await insertUsage(env, { accountId, status: 'pending', holdMicros: 5_000 });
    // Another account's rows never leak in.
    await insertUsage(env, { accountId: uniq('acct'), status: 'settled', chargeMicros: 999 });
    expect(await getBalance(env.DB, accountId)).toEqual({
      balanceMicros: 7_998_000,
      heldMicros: 25_000,
    });
  });

  it('rejects non-integer amounts', async () => {
    await expect(
      grantCredit(env.DB, {
        accountId: uniq('acct'),
        kind: 'adjustment',
        amountMicros: 1.5,
        stripeRef: null,
      }),
    ).rejects.toThrow(/integer/);
  });
});

describe('markupFor', () => {
  it('is the prepaid rate without a subscription and the monthly rate with an active one', async () => {
    const account = simpleAccount();
    expect(await markupFor(env, account)).toBe(1000);
    await insertSubscription(env, account.userId!, 'past_due');
    expect(await markupFor(env, account)).toBe(1000);
    await insertSubscription(env, account.userId!, 'active');
    expect(await markupFor(env, account)).toBe(500);
  });

  it('reads MARKUP_*_BPS and falls back on invalid values', async () => {
    const account = simpleAccount();
    expect(await markupFor({ ...env, MARKUP_PREPAID_BPS: '2500' }, account)).toBe(2500);
    expect(await markupFor({ ...env, MARKUP_PREPAID_BPS: 'oops' }, account)).toBe(1000);
    await insertSubscription(env, account.userId!, 'active');
    expect(await markupFor({ ...env, MARKUP_MONTHLY_BPS: '0' }, account)).toBe(0);
  });

  it('uses the prepaid rate for an account without a user (dev mode)', async () => {
    expect(
      await markupFor(env, { id: 'default', mode: 'power', userId: null, operatorKeys: true }),
    ).toBe(1000);
  });
});

describe('assertCanSpend', () => {
  it("is a no-op for power accounts and for Learn on the user's own key", async () => {
    await expect(
      assertCanSpend(env, { id: 'default', mode: 'power', userId: null, operatorKeys: true }),
    ).resolves.toBeUndefined();
    await expect(
      assertCanSpend(env, { ...simpleAccount(), operatorKeys: false }),
    ).resolves.toBeUndefined();
  });

  it('gives 402 at a zero balance and passes after a grant', async () => {
    const account = simpleAccount();
    const err = await assertCanSpend(env, account).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect((err as PaymentRequiredError).code).toBe('payment_required');
    await grantCredit(env.DB, {
      accountId: account.id,
      kind: 'purchase',
      amountMicros: 5_000_000,
      stripeRef: uniq('cs'),
    });
    await expect(assertCanSpend(env, account)).resolves.toBeUndefined();
  });

  it('counts pending holds against the available balance', async () => {
    const account = simpleAccount();
    await grantCredit(env.DB, {
      accountId: account.id,
      kind: 'adjustment',
      amountMicros: 39_999,
      stripeRef: null,
    });
    await expect(assertCanSpend(env, account)).resolves.toBeUndefined();
    await insertUsage(env, { accountId: account.id, status: 'pending', holdMicros: 20_000 });
    await expect(assertCanSpend(env, account)).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it('refuses when billing is not configured', async () => {
    const account = simpleAccount();
    await grantCredit(env.DB, {
      accountId: account.id,
      kind: 'adjustment',
      amountMicros: 5_000_000,
      stripeRef: null,
    });
    const err = await assertCanSpend({ ...env, STRIPE_WEBHOOK_SECRET: '' }, account).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DomainError);
    expect(err).not.toBeInstanceOf(PaymentRequiredError);
    expect((err as DomainError).code).toBe('bad_request');
    expect((err as DomainError).message).toBe('Billing is not configured');
  });
});

describe('billing summary', () => {
  it('reports balance, holds, markup, fee, last purchase, plans and the subscription', async () => {
    const account = simpleAccount();
    await grantCredit(env.DB, {
      accountId: account.id,
      kind: 'purchase',
      amountMicros: 10_000_000,
      grossMicros: 10_670_000,
      feeMicros: 670_000,
      stripeRef: uniq('cs'),
    });
    // Without a gross amount (an adjustment), a grant is not a purchase to show.
    await grantCredit(env.DB, {
      accountId: account.id,
      kind: 'adjustment',
      amountMicros: 0,
      stripeRef: null,
    });
    await insertUsage(env, { accountId: account.id, status: 'settled', chargeMicros: 1_000_000 });
    await insertUsage(env, { accountId: account.id, status: 'pending', holdMicros: 20_000 });
    const periodEnd = Date.UTC(2026, 10, 1);
    await insertSubscription(env, account.userId!, 'incomplete', { plan: 'ignored' });
    await insertSubscription(env, account.userId!, 'active', {
      periodEnd,
      cancelAtPeriodEnd: true,
    });

    expect(await getBillingSummary(env, account)).toEqual({
      enabled: true,
      topUpsEnabled: true,
      currency: 'usd',
      balanceMicros: 9_000_000,
      heldMicros: 20_000,
      availableMicros: 8_980_000,
      markupBps: 500,
      openRouterFeeBps: 550,
      lastPurchase: {
        kind: 'purchase',
        grossMicros: 10_670_000,
        feeMicros: 670_000,
        creditMicros: 10_000_000,
        createdAt: expect.any(String),
      },
      subscription: {
        plan: 'monthly-10',
        status: 'active',
        periodEnd: new Date(periodEnd).toISOString(),
        cancelAtPeriodEnd: true,
      },
      monthlyPlans: [{ name: 'monthly-10', label: '$10 / month', amountCents: 1000 }],
      minTopUpCents: 500,
      maxTopUpCents: 50_000,
    });
  });

  it('works for a brand-new account and with billing disabled', async () => {
    const summary = await getBillingSummary({ ...env, STRIPE_SECRET_KEY: '' }, simpleAccount());
    expect(summary).toMatchObject({
      enabled: false,
      topUpsEnabled: false,
      balanceMicros: 0,
      availableMicros: 0,
      markupBps: 1000,
      openRouterFeeBps: 550,
      lastPurchase: null,
      subscription: null,
    });
    const custom = await getBillingSummary({ ...env, OPENROUTER_FEE_BPS: '700' }, simpleAccount());
    expect(custom.openRouterFeeBps).toBe(700);
    const bad = await getBillingSummary({ ...env, OPENROUTER_FEE_BPS: 'x' }, simpleAccount());
    expect(bad.openRouterFeeBps).toBe(550);
  });

  it('reports top-ups as unavailable without a credits product, though billing is enabled', async () => {
    const summary = await getBillingSummary(
      { ...env, STRIPE_CREDITS_PRODUCT_ID: '' },
      simpleAccount(),
    );
    expect(summary).toMatchObject({ enabled: true, topUpsEnabled: false });
  });
});

describe('stripe config', () => {
  it('billing needs both secrets', () => {
    expect(billingConfigured(env)).toBe(true);
    expect(billingConfigured({ ...env, STRIPE_SECRET_KEY: ' ' })).toBe(false);
    expect(billingConfigured({ ...env, STRIPE_WEBHOOK_SECRET: '' })).toBe(false);
  });

  it('parses STRIPE_PLANS safely', () => {
    expect(stripePlans(env)).toEqual([
      {
        name: 'monthly-10',
        label: '$10 / month',
        priceId: 'price_test_monthly_10',
        amountCents: 1000,
      },
    ]);
    expect(stripePlans({ ...env, STRIPE_PLANS: '' })).toEqual([]);
    expect(stripePlans({ ...env, STRIPE_PLANS: '[]' })).toEqual([]);
    expect(stripePlans({ ...env, STRIPE_PLANS: '{not json' })).toEqual([]);
    expect(stripePlans({ ...env, STRIPE_PLANS: '{"name":"x"}' })).toEqual([]);
    expect(
      stripePlans({
        ...env,
        STRIPE_PLANS: JSON.stringify([
          { name: 'ok', label: 'OK', priceId: 'price_1', amountCents: 2000, extra: true },
          { name: 'bad', label: 'Bad', priceId: '', amountCents: 1000 },
          { name: 'bad2', label: 'Bad', priceId: 'price_2', amountCents: 10.5 },
        ]),
      }),
    ).toEqual([{ name: 'ok', label: 'OK', priceId: 'price_1', amountCents: 2000 }]);
  });
});

describe('usage history', () => {
  async function seed(account: AccountContext, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      // Two rows share each timestamp, so the id tie-break is exercised.
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 2))).toISOString();
      ids.push(
        await insertUsage(env, {
          accountId: account.id,
          createdAt,
          status: 'settled',
          chargeMicros: i,
          treeId: 't1',
        }),
      );
    }
    return ids;
  }

  it('pages newest first with a cursor and never repeats or skips', async () => {
    const account = simpleAccount();
    await seed(account, 7);
    await insertUsage(env, { accountId: uniq('acct'), status: 'settled', chargeMicros: 1 });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listUsage(env, account, cursor, 3);
      expect(page.entries.length).toBeLessThanOrEqual(3);
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);

    const all = await listUsage(env, account, null, 100);
    expect(all.nextCursor).toBeNull();
    expect(all.entries.map((e) => e.id)).toEqual(seen);
    const times = all.entries.map((e) => e.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(all.entries[0]).toMatchObject({
      purpose: 'reply',
      model: 'smart',
      treeId: 't1',
      status: 'settled',
      chargeMicros: 6,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it('clamps the page size to 1..100 and rejects a bad cursor', async () => {
    const account = simpleAccount();
    await seed(account, 3);
    expect((await listUsage(env, account, null, 0)).entries).toHaveLength(1);
    expect((await listUsage(env, account, null, 1000)).entries).toHaveLength(3);
    await expect(listUsage(env, account, 'not-a-cursor', 10)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
