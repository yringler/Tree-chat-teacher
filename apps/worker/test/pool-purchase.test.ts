// Buying credit for the community pool (docs/pool/PLAN.md §S5): checkout
// targets, the payment webhook's pool fulfilment (net of the processing fee),
// refunds and disputes through PoolBank.debit (more in payments-*.test.ts),
// the admin's credit route and pool panel.
import {
  POOL_FUND_PRESETS_CENTS,
  type AdminCreditResponse,
  type AdminPoolResponse,
  type ApiError,
  type CheckoutResponse,
  type TreeDetail,
} from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- `?raw` is a Vite import; the worker tsconfig has no vite/client types.
import wranglerText from '../wrangler.jsonc?raw';
import { getBalance } from '../src/billing/ledger.js';
import { decodeFakeUrl } from '../src/billing/providers/fake.js';
import { fulfilPurchase } from '../src/billing/purchases.js';
import { applyPaymentEvent } from '../src/billing/payments/apply.js';
import { appConfig } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { poolBank } from '../src/pool/ids.js';
import { isSupporter } from '../src/pool/supporter.js';
import { insertUser, uniq } from './mocks/billing-helpers.js';
import { disputed, paid, refunded } from './mocks/payment-events.js';
import { fundPool, poolAccess, poolReadyUser } from './pool-helpers.js';
import { authEnv } from './session-client.js';

const env = rawEnv as unknown as AppEnv;
const ORIGIN = 'https://tangent.example.com';

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

describe('pool purchases through the payment webhook', () => {
  it('credits a pool purchase once, net of the fee, and makes the buyer a supporter', async () => {
    const poolId = uniq('pool');
    const buyer = uniq('user');
    await insertUser(env, { id: buyer });
    const payment = paid({ userId: buyer, target: 'pool', accountId: poolId, feeCents: 80 });
    expect(await applyPaymentEvent(env, payment, { provider: null })).toBe('applied');
    expect(await applyPaymentEvent(env, payment, { provider: null })).toBe('duplicate');
    expect(await grants(poolId)).toEqual([
      {
        account_id: poolId,
        kind: 'purchase',
        amount_micros: 9_200_000,
        gross_micros: 10_000_000,
        fee_micros: 800_000,
        margin_bps: 0,
        user_id: buyer,
        provider_ref: payment.paymentRef,
        note: 'Community pool purchase',
      },
    ]);
    // The buyer's personal ledger is untouched, and they are now a supporter.
    expect(await balance(`u_${buyer}`)).toBe(0);
    expect(await isSupporter(env.DB, buyer, new Date(), null)).toBe(true);
    // Refunded in full: no longer a supporter, and the pool gives back what it was credited.
    await applyPaymentEvent(env, refunded(payment.paymentRef, 1000), { provider: null });
    expect(await balance(poolId)).toBe(0);
    expect(await isSupporter(env.DB, buyer, new Date(), null)).toBe(false);
  });

  it('a lost dispute of a pool purchase suspends its buyer’s pool access', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const poolId = uniq('pool');
    const buyer = uniq('user');
    await insertUser(env, { id: buyer });
    const payment = paid({ userId: buyer, target: 'pool', accountId: poolId });
    await applyPaymentEvent(env, payment, { provider: null });
    await applyPaymentEvent(env, disputed('dispute.lost', payment.paymentRef, 1000), {
      provider: null,
    });
    expect((await poolAccess(buyer))?.pool_suspended).toBe(1);
    warn.mockRestore();
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
    const pool = decodeFakeUrl((await json<CheckoutResponse>(await checkout(1000, 'pool'))).url);
    expect(pool.input).toMatchObject({
      buyer: { userId },
      target: 'pool',
      accountId: poolId,
      amountCents: 1000,
      // The billing page then waits for the pool's balance, not the buyer's.
      successUrl: `${ORIGIN}/learn/billing?checkout=success&target=pool`,
      cancelUrl: `${ORIGIN}/learn/billing?checkout=cancel&target=pool`,
    });
    // No target: a personal top-up, as before ($5 is enough there).
    const personal = decodeFakeUrl((await json<CheckoutResponse>(await checkout(500))).url);
    expect(personal.input).toMatchObject({
      target: 'personal',
      accountId: `u_${userId}`,
      amountCents: 500,
      successUrl: `${ORIGIN}/learn/billing?checkout=success`,
    });
    await json<ApiError>(await checkout(1000, 'charity'), 400);
  });

  it('refuses pool checkouts until POOL_PURCHASES_ENABLED (personal top-ups stay open)', async () => {
    const { client } = await poolReadyUser({ funds: 0 });
    const closed = authEnv({ POOL_PURCHASES_ENABLED: 'false' });
    const checkout = (target: string) =>
      client.call(
        '/api/billing/checkout',
        { method: 'POST', json: { amountCents: 1000, target }, learn: 'pool' },
        closed,
      );
    expect((await json<ApiError>(await checkout('pool'), 400)).error.message).toBe(
      'Funding the community pool is not open yet',
    );
    await json<CheckoutResponse>(await checkout('personal'));
    // As deployed (wrangler.jsonc): closed.
    expect(/"POOL_PURCHASES_ENABLED"\s*:\s*"([^"]*)"/.exec(wranglerText as string)?.[1]).toBe(
      'false',
    );
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

  it('admin-granted personal credit is spendable with PERSONAL_CREDIT_ENABLED and no payments', async () => {
    const noPayments = {
      // Polar without its secrets: no payment provider is configured.
      PAYMENT_PROVIDER: 'polar',
      PERSONAL_CREDIT_ENABLED: 'true',
    };
    const { user, credit, e } = await setup({ env: noPayments });
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
