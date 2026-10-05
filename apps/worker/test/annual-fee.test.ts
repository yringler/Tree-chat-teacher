// ANNUAL_FEE_ENABLED (docs/pool/PLAN.md §S7): the yearly membership is
// required to generate only while the flag is on. Off (the default), the
// membership code paths stay but require nothing, whatever
// STRIPE_MEMBERSHIP_PRICE_ID says: any signed-in user may learn from the pool
// (within its caps) and buy personal credit. On, every generating route,
// pool sends included, answers 402 `membership_required` until it is paid.
import type {
  ApiError,
  CheckoutResponse,
  LearnPayment,
  MeResponse,
  StreamEvent,
  TreeDetail,
} from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { membershipRequired } from '../src/billing/membership.js';
import { appConfig } from '../src/config.js';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AppEnv } from '../src/env.js';
import { makeNode } from './fixtures.js';
import { poolReadyUser } from './pool-helpers.js';

const env = rawEnv as unknown as AppEnv;
/** Billing and the membership price configured; only the flag differs. */
const feeEnv = (on: boolean): Partial<AppEnv> => ({
  ANNUAL_FEE_ENABLED: on ? 'true' : 'false',
  STRIPE_MEMBERSHIP_PRICE_ID: 'price_test_membership',
});

type User = Awaited<ReturnType<typeof poolReadyUser>>;

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

function lastEvent(text: string): StreamEvent | undefined {
  return text
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as StreamEvent)
    .at(-1);
}

/** A Learn tree with a user/assistant exchange on its trunk (written directly). */
async function treeWithNodes(u: User, learn: LearnPayment) {
  const detail = await json<TreeDetail>(
    await u.client.call('/api/trees', { method: 'POST', json: { title: 'T' }, learn }),
    201,
  );
  const trunk = detail.branches[0]!;
  const user = makeNode(trunk, 0, null, { role: 'user', content: 'What is a prime?' });
  const assistant = makeNode(trunk, 1, user.id, {
    role: 'assistant',
    content: 'A number with exactly two divisors.',
  });
  await createD1Repositories(env.DB).trees.appendNodes([user, assistant], new Date().toISOString());
  return { trunk, assistant };
}

describe('ANNUAL_FEE_ENABLED', () => {
  it('defaults to off, and gates the membership requirement', () => {
    expect(appConfig({ ...env, ANNUAL_FEE_ENABLED: '' }).flags.annualFeeEnabled).toBe(false);
    expect(appConfig({ ...env, ...feeEnv(true) }).flags.annualFeeEnabled).toBe(true);
    expect(membershipRequired({ ...env, ...feeEnv(false) })).toBe(false);
    expect(membershipRequired({ ...env, ...feeEnv(true) })).toBe(true);
    // On, it still needs billing and the price id.
    expect(membershipRequired({ ...env, ANNUAL_FEE_ENABLED: 'true' })).toBe(false);
    expect(membershipRequired({ ...env, ...feeEnv(true), STRIPE_SECRET_KEY: '' })).toBe(false);
  });

  describe('off, with the membership price set', () => {
    it('/api/me requires no membership, in both apps', async () => {
      const u = await poolReadyUser({ env: feeEnv(false) });
      for (const learn of [undefined, 'pool'] as const) {
        const me = await json<MeResponse>(await u.client.call('/api/me', learn ? { learn } : {}));
        expect(me.membership).toMatchObject({ required: false, status: 'inactive' });
      }
    });

    it('a signed-in user learns from the pool without a membership', async () => {
      const u = await poolReadyUser({ env: feeEnv(false) });
      const { trunk } = await treeWithNodes(u, 'pool');
      const res = await u.client.call(`/api/branches/${trunk.id}/messages`, {
        method: 'POST',
        json: { content: 'Explain primes' },
        learn: 'pool',
      });
      expect(res.status).toBe(200);
      expect(lastEvent(await res.text())?.type).toBe('done');
      const resolve = await u.client.call(`/api/branches/${trunk.id}/context?resolve=true`, {
        learn: 'pool',
      });
      expect(resolve.status).toBe(200);
    });

    it('and still within the pool caps (3 replies a day in the tests)', async () => {
      const u = await poolReadyUser({ env: feeEnv(false) });
      const { trunk } = await treeWithNodes(u, 'pool');
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await u.client.call(`/api/branches/${trunk.id}/messages`, {
          method: 'POST',
          json: { content: `Question ${i}` },
          learn: 'pool',
        });
        statuses.push(res.status);
        if (res.status !== 200)
          expect((await json<ApiError>(res, 429)).error.code).toBe('pool_cap_reached');
        else await res.text();
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
    });

    it('a signed-in user buys personal credit without a membership', async () => {
      const u = await poolReadyUser({ env: feeEnv(false) });
      for (const learn of [undefined, 'pool'] as const) {
        const res = await u.client.call('/api/billing/checkout', {
          method: 'POST',
          json: { amountCents: 500 },
          ...(learn ? { learn } : {}),
        });
        expect((await json<CheckoutResponse>(res)).url).toMatch(
          /^https:\/\/checkout\.stripe\.com\//,
        );
      }
    });
  });

  describe('on, with the membership price set', () => {
    it('402 membership_required on send, review and context?resolve, pool sends included', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      expect(
        (await json<MeResponse>(await u.client.call('/api/me', { learn: 'pool' }))).membership,
      ).toMatchObject({ required: true, status: 'inactive' });
      for (const learn of ['pool', 'credit', 'own-key'] as const) {
        const { trunk, assistant } = await treeWithNodes(u, learn);
        for (const [path, init] of [
          [`/api/branches/${trunk.id}/messages`, { method: 'POST', json: { content: 'Hi' } }],
          [
            `/api/nodes/${assistant.id}/review`,
            { method: 'POST', json: { providerId: 'tangent', model: 'smart' } },
          ],
          [`/api/branches/${trunk.id}/context?resolve=true`, {}],
        ] as const) {
          const res = await u.client.call(path, { ...init, learn });
          expect(res.status, `${learn} ${path}`).toBe(402);
          expect((await json<ApiError>(res, 402)).error.code).toBe('membership_required');
        }
      }
    });

    it('a signed-in user still buys personal credit: checkout is never membership-gated', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      for (const learn of [undefined, 'pool'] as const) {
        const res = await u.client.call('/api/billing/checkout', {
          method: 'POST',
          json: { amountCents: 500 },
          ...(learn ? { learn } : {}),
        });
        expect((await json<CheckoutResponse>(res)).url).toMatch(
          /^https:\/\/checkout\.stripe\.com\//,
        );
      }
    });
  });
});
