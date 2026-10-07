import { MembershipRequiredError } from '@tangent/core';
import type { ApiError, BillingSummary, MembershipInfo } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  assertMember,
  membershipFor,
  membershipRequired,
  redeemWaiverCode,
} from '../src/billing/membership.js';
import type { AccountContext, AppBindings, AppEnv } from '../src/env.js';
import { onError } from '../src/http/errors.js';
import { billingRoutes } from '../src/routes/billing.js';
import {
  devPowerAccount,
  insertSubscription,
  insertUser,
  powerAccount,
  simpleAccount,
  uniq,
} from './mocks/billing-helpers.js';

const env = rawEnv as unknown as AppEnv;
const BASE = 'https://tangent.example.com';
const CODE = 'friends-of-tangent';
/** The membership sold and required (vitest.config.ts leaves it off), with a waiver code. */
const memberEnv: AppEnv = {
  ...env,
  ANNUAL_FEE_ENABLED: 'true',
  MEMBERSHIP_WAIVER_CODE: CODE,
};

/** A signed-in user's power account, with its auth_users row. */
async function member(): Promise<AccountContext> {
  const account = powerAccount();
  await insertUser(env, { id: account.userId!, email: `${uniq('m')}@example.com` });
  return account;
}

async function isWaived(userId: string): Promise<{ waived: number; at: string | null }> {
  const row = await env.DB.prepare(
    'SELECT membership_waived AS waived, membership_waived_at AS at FROM auth_users WHERE id = ?',
  )
    .bind(userId)
    .first<{ waived: number; at: string | null }>();
  return row!;
}

/** billingRoutes() behind a stand-in for the session/account middleware. */
function appAs(account: AccountContext, e: AppEnv = memberEnv) {
  const app = new Hono<AppBindings>();
  app.onError(onError);
  app.use('*', async (c, next) => {
    c.set('account', account);
    c.set('accountId', account.id);
    await next();
  });
  app.route('/api/billing', billingRoutes());
  return (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (json !== undefined) headers.set('Content-Type', 'application/json');
    return app.request(
      `${BASE}${path}`,
      { ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) },
      e,
    );
  };
}

async function body<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

const redeem = (code: string) => ({
  method: 'POST',
  json: { code },
  headers: { 'Sec-Fetch-Site': 'same-origin' },
});

describe('membership', () => {
  it('is not required unless sold, without billing, or in the dev bypass', async () => {
    expect(membershipRequired(env)).toBe(false);
    expect(
      membershipRequired({ ...memberEnv, FAKE_PAYMENTS: JSON.stringify({ membership: false }) }),
    ).toBe(false);
    expect(membershipRequired({ ...memberEnv, PAYMENT_PROVIDER: 'polar' })).toBe(false);
    expect(membershipRequired(memberEnv)).toBe(true);
    const account = await member();
    expect(await membershipFor(env, account)).toEqual({
      required: false,
      status: 'inactive',
      subscriptionStatus: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      priceCents: 1000,
      includedCreditCents: 0,
    });
    expect((await membershipFor(memberEnv, devPowerAccount())).required).toBe(false);
    await expect(assertMember(env, account)).resolves.toBeUndefined();
    await expect(assertMember(memberEnv, devPowerAccount())).resolves.toBeUndefined();
  });

  it('is required and inactive without a subscription; the gate throws 402 membership_required', async () => {
    const account = await member();
    expect(await membershipFor(memberEnv, account)).toMatchObject({
      required: true,
      status: 'inactive',
      subscriptionStatus: null,
    });
    const err = await assertMember(memberEnv, account).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MembershipRequiredError);
    expect((err as MembershipRequiredError).code).toBe('membership_required');
  });

  it('is active with an active, trialing or past_due membership row, in both modes', async () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      const account = await member();
      const periodEnd = Date.UTC(2027, 9, 1);
      await insertSubscription(env, account.userId!, status, {
        periodEnd,
        cancelAtPeriodEnd: true,
      });
      for (const a of [account, simpleAccount(account.userId!)]) {
        expect(await membershipFor(memberEnv, a)).toEqual({
          required: true,
          status: 'active',
          subscriptionStatus: status,
          periodEnd: new Date(periodEnd).toISOString(),
          cancelAtPeriodEnd: true,
          priceCents: 1000,
          includedCreditCents: 0,
        });
        await expect(assertMember(memberEnv, a)).resolves.toBeUndefined();
      }
    }
  });

  it('is inactive with a canceled, unpaid or incomplete row, or another kind', async () => {
    const account = await member();
    await insertSubscription(env, account.userId!, 'incomplete');
    expect(await membershipFor(memberEnv, account)).toMatchObject({
      status: 'inactive',
      subscriptionStatus: null,
    });
    await insertSubscription(env, account.userId!, 'active', { kind: 'monthly-10' });
    await insertSubscription(env, account.userId!, 'unpaid', { periodEnd: 1 });
    await insertSubscription(env, account.userId!, 'canceled', { periodEnd: 2 });
    // The latest period wins among the inactive ones.
    expect(await membershipFor(memberEnv, account)).toMatchObject({
      status: 'inactive',
      subscriptionStatus: 'canceled',
    });
    // A paid row wins over a later inactive one.
    await insertSubscription(env, account.userId!, 'past_due', { periodEnd: 0 });
    expect((await membershipFor(memberEnv, account)).status).toBe('active');
  });

  it('is waived by the flag, which wins over the subscription', async () => {
    const account = await member();
    await insertSubscription(env, account.userId!, 'canceled');
    await env.DB.prepare('UPDATE auth_users SET membership_waived = 1 WHERE id = ?')
      .bind(account.userId)
      .run();
    expect(await membershipFor(memberEnv, account)).toMatchObject({
      required: true,
      status: 'waived',
      subscriptionStatus: 'canceled',
    });
    await expect(assertMember(memberEnv, account)).resolves.toBeUndefined();
  });

  it('includes no credit when the built-in provider is not offered', async () => {
    // None by default; MEMBERSHIP_CREDIT_CENTS sets some, unless there is nothing to spend it on.
    expect((await membershipFor(memberEnv, await member())).includedCreditCents).toBe(0);
    const info = await membershipFor(
      {
        ...memberEnv,
        MEMBERSHIP_CREDIT_CENTS: '350',
        SIMPLE_PROVIDER: '',
        OPENROUTER_SIMPLE_API_KEY: '',
      } as AppEnv,
      await member(),
    );
    expect(info.includedCreditCents).toBe(0);
    expect(
      (await membershipFor({ ...memberEnv, MEMBERSHIP_CREDIT_CENTS: '350' }, await member()))
        .includedCreditCents,
    ).toBe(350);
  });

  it('shows in the billing summary', async () => {
    const account = await member();
    await insertSubscription(env, account.userId!, 'active');
    const summary = await body<BillingSummary>(await appAs(account)('/api/billing'), 200);
    expect(summary.membership).toMatchObject({ required: true, status: 'active' });
    expect(summary).not.toHaveProperty('monthlyPlans');
    expect(summary).not.toHaveProperty('subscription');
  });
});

describe('membership waiver code', () => {
  it('the right code sets the flag (once) and returns the membership', async () => {
    const account = await member();
    const call = appAs(account);
    const info = await body<MembershipInfo>(
      await call('/api/billing/membership/waiver', redeem(`  ${CODE} `)),
      200,
    );
    expect(info).toMatchObject({ required: true, status: 'waived' });
    const first = await isWaived(account.userId!);
    expect(first.waived).toBe(1);
    expect(first.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    // Redeeming again (e.g. from the other app) keeps the original time.
    await body<MembershipInfo>(
      await appAs(simpleAccount(account.userId!))('/api/billing/membership/waiver', redeem(CODE)),
      200,
    );
    expect(await isWaived(account.userId!)).toEqual(first);
  });

  it('a wrong code is 403 and changes nothing', async () => {
    const account = await member();
    const call = appAs(account);
    for (const code of ['nope', `${CODE}x`, CODE.slice(0, -1)]) {
      const err = await body<ApiError>(
        await call('/api/billing/membership/waiver', redeem(code)),
        403,
      );
      expect(err.error.code).toBe('forbidden');
    }
    expect((await isWaived(account.userId!)).waived).toBe(0);
  });

  it('is 400 when no code is configured, or the body is invalid', async () => {
    const account = await member();
    const none = appAs(account, { ...memberEnv, MEMBERSHIP_WAIVER_CODE: ' ' });
    const err = await body<ApiError>(
      await none('/api/billing/membership/waiver', redeem(CODE)),
      400,
    );
    expect(err.error.code).toBe('bad_request');
    const call = appAs(account);
    await body<ApiError>(await call('/api/billing/membership/waiver', redeem('   ')), 400);
    await body<ApiError>(
      await call('/api/billing/membership/waiver', { ...redeem(CODE), json: {} }),
      400,
    );
    expect((await isWaived(account.userId!)).waived).toBe(0);
  });

  it('is same-origin only, and 401 in the dev bypass', async () => {
    const account = await member();
    await body<ApiError>(
      await appAs(account)('/api/billing/membership/waiver', {
        ...redeem(CODE),
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      }),
      403,
    );
    expect((await isWaived(account.userId!)).waived).toBe(0);
    const dev = await body<ApiError>(
      await appAs(devPowerAccount())('/api/billing/membership/waiver', redeem(CODE)),
      401,
    );
    expect(dev.error.code).toBe('unauthorized');
    await expect(redeemWaiverCode(memberEnv, devPowerAccount(), CODE)).rejects.toThrow(/Sign in/);
  });

  it('is rate limited per account with the key limiter, before the code is compared', async () => {
    const account = await member();
    const keys: string[] = [];
    const limiter = {
      limit: ({ key }: { key: string }) => {
        keys.push(key);
        return Promise.resolve({ success: false });
      },
    };
    const call = appAs(account, { ...memberEnv, KEY_RATE_LIMITER: limiter } as unknown as AppEnv);
    const err = await body<ApiError>(
      await call('/api/billing/membership/waiver', redeem(CODE)),
      429,
    );
    expect(err.error.code).toBe('rate_limited');
    expect(keys).toEqual([`key:account:${account.id}`]);
    expect((await isWaived(account.userId!)).waived).toBe(0);
  });
});
