import type {
  ApiError,
  BillingSummary,
  CheckoutResponse,
  UsageListResponse,
} from '@tangent/shared';
import { env as rawEnv, exports } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { grantCredit } from '../src/billing/ledger.js';
import { decodeFakeUrl } from '../src/billing/providers/fake.js';
import type { AccountContext, AppBindings, AppEnv } from '../src/env.js';
import { onError } from '../src/http/errors.js';
import { sameOriginWrites } from '../src/byok/guard.js';
import { billingRoutes } from '../src/routes/billing.js';
import {
  insertUsage,
  insertUser,
  powerAccount,
  simpleAccount,
  uniq,
} from './mocks/billing-helpers.js';
import { BASE, ok } from './http.js';

const env = rawEnv as unknown as AppEnv;
/**
 * billingRoutes() behind app.ts's CSRF guard and a stand-in for the
 * session/account middleware, so these tests don't depend on how accounts
 * are resolved.
 */
function appAs(account: AccountContext, e: AppEnv = env) {
  const app = new Hono<AppBindings>();
  app.onError(onError);
  app.use('*', async (c, next) => {
    c.set('account', account);
    c.set('accountId', account.id);
    await next();
  });
  app.use('/api/*', sameOriginWrites);
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

describe('billing routes', () => {
  it("answer in power mode too, on the user's shared ledger", async () => {
    const account = powerAccount();
    await insertUser(env, { id: account.userId!, email: `${uniq('power')}@example.com` });
    await grantCredit(env.DB, {
      accountId: account.billingAccountId,
      kind: 'purchase',
      amountMicros: 2_000_000,
      providerRef: uniq('cs'),
    });
    await insertUsage(env, {
      accountId: account.billingAccountId,
      status: 'settled',
      chargeMicros: 500_000,
    });
    const call = appAs(account);
    expect(await ok<BillingSummary>(await call('/api/billing'), 200)).toMatchObject({
      enabled: true,
      builtInCredit: true,
      balanceMicros: 1_500_000,
    });
    expect(
      (await ok<UsageListResponse>(await call('/api/billing/usage'), 200)).entries,
    ).toHaveLength(1);
    const res = await call('/api/billing/checkout', {
      method: 'POST',
      json: { amountCents: 1000 },
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    expect((await ok<CheckoutResponse>(res, 200)).url).toMatch(
      /^https:\/\/fake-pay\.invalid\/checkout#/,
    );
  });

  it('GET / returns the summary (no-store)', async () => {
    const account = simpleAccount();
    await grantCredit(env.DB, {
      accountId: account.id,
      kind: 'purchase',
      amountMicros: 5_000_000,
      providerRef: uniq('cs'),
    });
    const res = await appAs(account)('/api/billing');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const summary = await ok<BillingSummary>(res, 200);
    expect(summary).toMatchObject({
      enabled: true,
      balanceMicros: 5_000_000,
      availableMicros: 5_000_000,
      markupBps: 1000,
    });
  });

  it('GET /usage pages with cursor and limit', async () => {
    const account = simpleAccount();
    for (let i = 0; i < 3; i++)
      await insertUsage(env, { accountId: account.id, status: 'settled', chargeMicros: i });
    const call = appAs(account);
    const first = await ok<UsageListResponse>(await call('/api/billing/usage?limit=2'), 200);
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const rest = await ok<UsageListResponse>(
      await call(`/api/billing/usage?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`),
      200,
    );
    expect(rest.entries).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    expect(
      (await ok<UsageListResponse>(await call('/api/billing/usage'), 200)).entries,
    ).toHaveLength(3);
    await ok<ApiError>(await call('/api/billing/usage?limit=101'), 400);
    await ok<ApiError>(await call('/api/billing/usage?limit=0'), 400);
    await ok<ApiError>(await call('/api/billing/usage?cursor=@@@'), 400);
  });

  it('POST /checkout validates, is same-origin only, and returns the Checkout URL', async () => {
    const account = simpleAccount();
    await insertUser(env, { id: account.userId!, email: `${uniq('route')}@example.com` });
    const call = appAs(account);
    for (const amountCents of [499, 50_001, 12.5]) {
      await ok<ApiError>(
        await call('/api/billing/checkout', { method: 'POST', json: { amountCents } }),
        400,
      );
    }
    const cross = await call('/api/billing/checkout', {
      method: 'POST',
      json: { amountCents: 1000 },
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    await ok<ApiError>(cross, 403);
    const res = await call('/api/billing/checkout', {
      method: 'POST',
      json: { amountCents: 1000 },
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    expect((await ok<CheckoutResponse>(res, 200)).url).toMatch(
      /^https:\/\/fake-pay\.invalid\/checkout#/,
    );
  });

  it('POST /membership/checkout and /portal open the provider’s pages, same-origin only', async () => {
    const account = simpleAccount();
    await insertUser(env, { id: account.userId!, email: `${uniq('route')}@example.com` });
    const call = appAs(account);
    const same = { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' } };
    const membership = await ok<CheckoutResponse>(
      await call('/api/billing/membership/checkout', same),
      200,
    );
    expect(decodeFakeUrl(membership.url)).toMatchObject({
      page: 'membership',
      input: { successUrl: `${BASE}/learn/billing?checkout=success` },
    });
    const portal = await ok<CheckoutResponse>(await call('/api/billing/portal', same), 200);
    expect(decodeFakeUrl(portal.url)).toMatchObject({
      page: 'portal',
      input: { returnUrl: `${BASE}/learn/billing` },
    });
    for (const path of ['/api/billing/membership/checkout', '/api/billing/portal'])
      await ok<ApiError>(
        await call(path, { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } }),
        403,
      );
  });

  it('POST /portal is 404 `no_customer` while the provider has none, 502 when it is down', async () => {
    const account = simpleAccount();
    await insertUser(env, { id: account.userId!, email: `${uniq('route')}@example.com` });
    const same = { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' } };
    const none = appAs(account, { ...env, FAKE_PAYMENTS: '{"portalCustomer":false}' } as AppEnv);
    expect((await ok<ApiError>(await none('/api/billing/portal', same), 404)).error.code).toBe(
      'no_customer',
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down = appAs(account, { ...env, FAKE_PAYMENTS: '{"failCheckout":true}' } as AppEnv);
    expect(
      (await ok<ApiError>(await down('/api/billing/membership/checkout', same), 502)).error.code,
    ).toBe('provider_error');
    error.mockRestore();
  });

  it('POST /checkout needs a known user', async () => {
    const call = appAs(simpleAccount());
    await ok<ApiError>(
      await call('/api/billing/checkout', { method: 'POST', json: { amountCents: 1000 } }),
      401,
    );
  });

  it('is mounted at /api/billing and answers the dev-mode power account', async () => {
    const res = await exports.default.fetch(new Request(`${BASE}/api/billing`));
    expect(await ok<BillingSummary>(res, 200)).toMatchObject({ enabled: true });
  });
});
