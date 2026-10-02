import type {
  ApiError,
  BillingSummary,
  CheckoutResponse,
  UsageListResponse,
} from '@tangent/shared';
import { env as rawEnv, exports } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { grantCredit } from '../src/billing/ledger.js';
import type { AccountContext, AppBindings, AppEnv } from '../src/env.js';
import { onError } from '../src/http/errors.js';
import { billingRoutes } from '../src/routes/billing.js';
import { insertUsage, insertUser, simpleAccount, uniq } from './mocks/billing-helpers.js';

const env = rawEnv as unknown as AppEnv;
const BASE = 'https://tangent.example.com';

/**
 * billingRoutes() behind a stand-in for the session/account middleware, so
 * these tests don't depend on how accounts are resolved.
 */
function appAs(account: AccountContext) {
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
      env,
    );
  };
}

async function body<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

describe('billing routes', () => {
  it('are forbidden for power accounts', async () => {
    const call = appAs({ id: 'default', mode: 'power', userId: null });
    for (const [path, init] of [
      ['/api/billing', {}],
      ['/api/billing/usage', {}],
      ['/api/billing/checkout', { method: 'POST', json: { amountCents: 1000 } }],
    ] as const) {
      const err = await body<ApiError>(await call(path, init), 403);
      expect(err.error.code).toBe('forbidden');
    }
  });

  it('GET / returns the summary (no-store)', async () => {
    const account = simpleAccount();
    await grantCredit(env.DB, {
      accountId: account.id,
      kind: 'purchase',
      amountMicros: 5_000_000,
      stripeRef: uniq('cs'),
    });
    const res = await appAs(account)('/api/billing');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const summary = await body<BillingSummary>(res, 200);
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
    const first = await body<UsageListResponse>(await call('/api/billing/usage?limit=2'), 200);
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const rest = await body<UsageListResponse>(
      await call(`/api/billing/usage?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`),
      200,
    );
    expect(rest.entries).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    expect(
      (await body<UsageListResponse>(await call('/api/billing/usage'), 200)).entries,
    ).toHaveLength(3);
    await body<ApiError>(await call('/api/billing/usage?limit=101'), 400);
    await body<ApiError>(await call('/api/billing/usage?limit=0'), 400);
    await body<ApiError>(await call('/api/billing/usage?cursor=@@@'), 400);
  });

  it('POST /checkout validates, is same-origin only, and returns the Checkout URL', async () => {
    const account = simpleAccount();
    await insertUser(env, { id: account.userId!, email: `${uniq('route')}@example.com` });
    const call = appAs(account);
    for (const amountCents of [499, 50_001, 12.5]) {
      await body<ApiError>(
        await call('/api/billing/checkout', { method: 'POST', json: { amountCents } }),
        400,
      );
    }
    const cross = await call('/api/billing/checkout', {
      method: 'POST',
      json: { amountCents: 1000 },
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    await body<ApiError>(cross, 403);
    const res = await call('/api/billing/checkout', {
      method: 'POST',
      json: { amountCents: 1000 },
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    expect((await body<CheckoutResponse>(res, 200)).url).toMatch(
      /^https:\/\/checkout\.stripe\.com\//,
    );
  });

  it('POST /checkout needs a known user', async () => {
    const call = appAs(simpleAccount());
    await body<ApiError>(
      await call('/api/billing/checkout', { method: 'POST', json: { amountCents: 1000 } }),
      401,
    );
  });

  it('is mounted at /api/billing and refuses the dev-mode power account', async () => {
    const res = await exports.default.fetch(new Request(`${BASE}/api/billing`));
    expect(res.status).toBe(403);
  });
});
