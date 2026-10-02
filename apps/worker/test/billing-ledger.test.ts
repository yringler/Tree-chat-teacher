import { DomainError, PaymentRequiredError, ValidationError } from '@tangent/core';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { getBalance, grantCredit, hasGrant } from '../src/billing/ledger.js';
import { assertCanSpend, getBillingSummary, listUsage, markupFor } from '../src/billing/service.js';
import { billingConfigured } from '../src/billing/stripe.js';
import type { AccountContext, AppEnv } from '../src/env.js';
import {
  devPowerAccount,
  insertSubscription,
  insertUsage,
  powerAccount,
  simpleAccount,
  uniq,
} from './mocks/billing-helpers.js';

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
  it('is MARKUP_BPS, the same for every user (1000 by default)', () => {
    expect(markupFor(env)).toBe(1000);
    expect(markupFor({ ...env, MARKUP_BPS: '2500' })).toBe(2500);
    expect(markupFor({ ...env, MARKUP_BPS: '0' })).toBe(0);
  });

  it('falls back to the deprecated MARKUP_PREPAID_BPS while MARKUP_BPS is empty, then to 1000', () => {
    expect(markupFor({ ...env, MARKUP_BPS: '', MARKUP_PREPAID_BPS: '1500' })).toBe(1500);
    expect(markupFor({ ...env, MARKUP_BPS: 'oops', MARKUP_PREPAID_BPS: '1500' })).toBe(1500);
    // MARKUP_BPS wins when both are set.
    expect(markupFor({ ...env, MARKUP_BPS: '800', MARKUP_PREPAID_BPS: '1500' })).toBe(800);
    expect(markupFor({ ...env, MARKUP_BPS: '', MARKUP_PREPAID_BPS: 'oops' })).toBe(1000);
    expect(markupFor({ ...env, MARKUP_BPS: '', MARKUP_PREPAID_BPS: '' })).toBe(1000);
  });
});

describe('assertCanSpend', () => {
  it("is a no-op for calls on the user's own keys, in either mode", async () => {
    // Power on a BYOK provider, even with the built-in provider in its registry.
    await expect(assertCanSpend(env, powerAccount(), 'ant')).resolves.toBeUndefined();
    await expect(
      assertCanSpend(env, devPowerAccount({ builtIn: false }), 'tangent'),
    ).resolves.toBeUndefined();
    // Learn on the user's own key.
    await expect(
      assertCanSpend(env, { ...simpleAccount(), builtIn: false }, 'tangent'),
    ).resolves.toBeUndefined();
  });

  it("checks the user's shared ledger for power calls on the built-in provider", async () => {
    const account = powerAccount();
    await expect(assertCanSpend(env, account, 'tangent')).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    // Credit bought in Learn (on u_<userId>) pays for power calls too.
    await grantCredit(env.DB, {
      accountId: account.billingAccountId,
      kind: 'purchase',
      amountMicros: 5_000_000,
      stripeRef: uniq('cs'),
    });
    await expect(assertCanSpend(env, account, 'tangent')).resolves.toBeUndefined();
  });

  it('gives 402 at a zero balance and passes after a grant', async () => {
    const account = simpleAccount();
    const err = await assertCanSpend(env, account, 'tangent').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect((err as PaymentRequiredError).code).toBe('payment_required');
    await grantCredit(env.DB, {
      accountId: account.id,
      kind: 'purchase',
      amountMicros: 5_000_000,
      stripeRef: uniq('cs'),
    });
    await expect(assertCanSpend(env, account, 'tangent')).resolves.toBeUndefined();
  });

  it('counts pending holds against the available balance', async () => {
    const account = simpleAccount();
    await grantCredit(env.DB, {
      accountId: account.id,
      kind: 'adjustment',
      amountMicros: 39_999,
      stripeRef: null,
    });
    await expect(assertCanSpend(env, account, 'tangent')).resolves.toBeUndefined();
    await insertUsage(env, { accountId: account.id, status: 'pending', holdMicros: 20_000 });
    await expect(assertCanSpend(env, account, 'tangent')).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
  });

  it('refuses when billing is not configured', async () => {
    const account = simpleAccount();
    await grantCredit(env.DB, {
      accountId: account.id,
      kind: 'adjustment',
      amountMicros: 5_000_000,
      stripeRef: null,
    });
    const err = await assertCanSpend(
      { ...env, STRIPE_WEBHOOK_SECRET: '' },
      account,
      'tangent',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).not.toBeInstanceOf(PaymentRequiredError);
    expect((err as DomainError).code).toBe('bad_request');
    expect((err as DomainError).message).toBe('Billing is not configured');
  });
});

describe('billing summary', () => {
  it('reports balance, holds, markup, fee, last purchase and the membership', async () => {
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
    // A subscription row doesn't matter while no membership is required.
    await insertSubscription(env, account.userId!, 'active');
    // Membership credit (no gross amount) is a gift, not a purchase to show.
    await grantCredit(env.DB, {
      accountId: account.id,
      kind: 'subscription',
      amountMicros: 2_000_000,
      grossMicros: null,
      stripeRef: uniq('in'),
    });

    expect(await getBillingSummary(env, account)).toEqual({
      enabled: true,
      membership: {
        required: false,
        status: 'inactive',
        stripeStatus: null,
        periodEnd: null,
        cancelAtPeriodEnd: false,
        priceCents: 1000,
        includedCreditCents: 200,
      },
      builtInCredit: true,
      topUpsEnabled: true,
      currency: 'usd',
      balanceMicros: 11_000_000,
      heldMicros: 20_000,
      availableMicros: 10_980_000,
      markupBps: 1000,
      openRouterFeeBps: 550,
      lastPurchase: {
        kind: 'purchase',
        grossMicros: 10_670_000,
        feeMicros: 670_000,
        creditMicros: 10_000_000,
        createdAt: expect.any(String),
      },
      minTopUpCents: 500,
      maxTopUpCents: 50_000,
    });
  });

  it('works for a brand-new account and with billing disabled', async () => {
    const summary = await getBillingSummary({ ...env, STRIPE_SECRET_KEY: '' }, simpleAccount());
    expect(summary).toMatchObject({
      enabled: false,
      builtInCredit: false,
      topUpsEnabled: false,
      balanceMicros: 0,
      availableMicros: 0,
      markupBps: 1000,
      openRouterFeeBps: 550,
      lastPurchase: null,
      membership: { required: false, includedCreditCents: 0 },
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

describe('billing summary in power mode', () => {
  it("shows the user's shared ledger: Learn credit and power usage alike", async () => {
    const power = powerAccount();
    await grantCredit(env.DB, {
      accountId: power.billingAccountId,
      kind: 'adjustment',
      amountMicros: 3_000_000,
      stripeRef: null,
    });
    await insertUsage(env, {
      accountId: power.billingAccountId,
      status: 'settled',
      chargeMicros: 1_000_000,
    });
    // The power account id itself holds no ledger.
    await grantCredit(env.DB, {
      accountId: power.id,
      kind: 'adjustment',
      amountMicros: 7_000_000,
      stripeRef: null,
    });
    expect(await getBillingSummary(env, power)).toMatchObject({
      builtInCredit: true,
      balanceMicros: 2_000_000,
    });
    expect((await listUsage(env, power, null, 10)).entries).toHaveLength(1);
  });
});

describe('stripe config', () => {
  it('billing needs both secrets', () => {
    expect(billingConfigured(env)).toBe(true);
    expect(billingConfigured({ ...env, STRIPE_SECRET_KEY: ' ' })).toBe(false);
    expect(billingConfigured({ ...env, STRIPE_WEBHOOK_SECRET: '' })).toBe(false);
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
