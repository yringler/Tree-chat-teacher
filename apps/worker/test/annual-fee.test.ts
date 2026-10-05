// ANNUAL_FEE_ENABLED (docs/pool/PLAN.md §S7): the yearly membership is
// required to generate only while the flag is on. Off (the default), the
// membership code paths stay but require nothing, whatever the payment
// provider sells: any signed-in user may learn from the pool
// (within its caps) and buy personal credit. On, Learn stays open on the
// pool (the free tier) and on the user's own key, while power mode, personal
// credit and buying credit answer 402 `membership_required` until it is paid;
// members get the pool's member caps.
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
import { insertSubscription } from './mocks/billing-helpers.js';
import { poolReadyUser } from './pool-helpers.js';

const env = rawEnv as unknown as AppEnv;
/** Billing and the membership sold (the fake provider sells it); only the flag differs. */
const feeEnv = (on: boolean): Partial<AppEnv> => ({
  ANNUAL_FEE_ENABLED: on ? 'true' : 'false',
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

/**
 * A tree with a user/assistant exchange on its trunk (written directly): in
 * Learn on `learn`, or in power mode (on the fake provider) without it.
 */
async function treeWithNodes(u: User, learn?: LearnPayment) {
  const detail = await json<TreeDetail>(
    await u.client.call(
      '/api/trees',
      learn
        ? { method: 'POST', json: { title: 'T' }, learn }
        : { method: 'POST', json: { title: 'T', providerId: 'fake', model: 'fake-1' } },
    ),
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
    // On, it still needs billing and a provider that sells it.
    expect(
      membershipRequired({
        ...env,
        ANNUAL_FEE_ENABLED: 'true',
        FAKE_PAYMENTS: JSON.stringify({ membership: false }),
      }),
    ).toBe(false);
    expect(membershipRequired({ ...env, ...feeEnv(true), PAYMENT_PROVIDER: 'polar' })).toBe(false);
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
          /^https:\/\/fake-pay\.invalid\/checkout#/,
        );
      }
    });
  });

  describe('on, with the membership price set', () => {
    /** A Learn send on `learn`: its status, the stream read through. */
    async function sendStatus(u: User, learn: LearnPayment, content = 'Hi'): Promise<number> {
      const { trunk } = await treeWithNodes(u, learn);
      const res = await u.client.call(`/api/branches/${trunk.id}/messages`, {
        method: 'POST',
        json: { content },
        learn,
      });
      await res.text();
      return res.status;
    }

    it('a non-member learns from the pool on the free tier; credit sends move to the pool', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      expect(
        (await json<MeResponse>(await u.client.call('/api/me', { learn: 'pool' }))).membership,
      ).toMatchObject({ required: true, status: 'inactive' });
      for (const learn of ['pool', 'credit'] as const) {
        const { trunk } = await treeWithNodes(u, learn);
        const res = await u.client.call(`/api/branches/${trunk.id}/messages`, {
          method: 'POST',
          json: { content: 'Explain primes' },
          learn,
        });
        expect(res.status, learn).toBe(200);
        expect(lastEvent(await res.text())?.type).toBe('done');
        const resolve = await u.client.call(`/api/branches/${trunk.id}/context?resolve=true`, {
          learn,
        });
        expect(resolve.status, learn).toBe(200);
      }
      const me = await json<{ member: boolean; caps: { requestsPerDay: number } }>(
        await u.client.call('/api/pool/me', { learn: 'pool' }),
      );
      expect(me).toMatchObject({ member: false, caps: { requestsPerDay: 3 } });
    });

    /** The three generating requests on a tree's trunk: send, review, context resolve. */
    function generating(tree: Awaited<ReturnType<typeof treeWithNodes>>, review: object) {
      return [
        [`/api/branches/${tree.trunk.id}/messages`, { method: 'POST', json: { content: 'Hi' } }],
        [`/api/nodes/${tree.assistant.id}/review`, { method: 'POST', json: review }],
        [`/api/branches/${tree.trunk.id}/context?resolve=true`, {}],
      ] as const;
    }

    it('a non-member learns on their own key: BYOK needs no membership', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      const own = await treeWithNodes(u, 'own-key');
      const send = await u.client.call(`/api/branches/${own.trunk.id}/messages`, {
        method: 'POST',
        json: { content: 'Explain primes' },
        learn: 'own-key',
      });
      expect(send.status).toBe(200);
      expect(lastEvent(await send.text())?.type).toBe('done');
      for (const [path, init] of generating(own, { providerId: 'tangent', model: 'smart' })) {
        const res = await u.client.call(path, { ...init, learn: 'own-key' });
        const text = await res.text();
        expect(res.status, `${path} ${text}`).not.toBe(402);
        expect(text, path).not.toContain('membership_required');
      }
    });

    it('402 membership_required for power mode: sends, reviews and context resolves', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      const power = await treeWithNodes(u);
      for (const [path, init] of generating(power, { providerId: 'fake', model: 'fake-1' })) {
        const res = await u.client.call(path, init);
        expect((await json<ApiError>(res, 402)).error.code, path).toBe('membership_required');
      }
    });

    it('a member uses power mode', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      await insertSubscription(env, u.userId, 'active');
      const power = await treeWithNodes(u);
      for (const [path, init] of generating(power, { providerId: 'fake', model: 'fake-1' })) {
        const res = await u.client.call(path, init);
        const text = await res.text();
        expect(res.status, `${path} ${text}`).toBe(200);
        if (path.endsWith('/messages')) expect(lastEvent(text)?.type).toBe('done');
      }
    });

    it('402 membership_required for a credit review: credit is members only', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      const credit = await treeWithNodes(u, 'credit');
      const review = await u.client.call(`/api/nodes/${credit.assistant.id}/review`, {
        method: 'POST',
        json: { providerId: 'tangent', model: 'smart' },
        learn: 'credit',
      });
      expect((await json<ApiError>(review, 402)).error.code).toBe('membership_required');
    });

    it('with the pool off, a credit send and resolve answer 402 instead of moving', async () => {
      const u = await poolReadyUser({ env: { ...feeEnv(true), POOL_ENABLED: 'false' } });
      const credit = await treeWithNodes(u, 'credit');
      for (const [path, init] of generating(credit, { providerId: 'tangent', model: 'smart' })) {
        const res = await u.client.call(path, { ...init, learn: 'credit' });
        expect((await json<ApiError>(res, 402)).error.code, path).toBe('membership_required');
      }
    });

    it('a member gets the member caps (6 replies a day in the tests)', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      await insertSubscription(env, u.userId, 'active');
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push(await sendStatus(u, 'pool', `Q${i}`));
      expect(statuses).toEqual([200, 200, 200, 200]);
      expect(
        await json<{ member: boolean }>(await u.client.call('/api/pool/me', { learn: 'pool' })),
      ).toMatchObject({ member: true, caps: { requestsPerDay: 6 } });
    });

    it('a waived user is a member too', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      await env.DB.prepare('UPDATE auth_users SET membership_waived = 1 WHERE id = ?')
        .bind(u.userId)
        .run();
      expect(
        await json<{ member: boolean }>(await u.client.call('/api/pool/me', { learn: 'pool' })),
      ).toMatchObject({ member: true });
    });

    it('buying credit needs a membership: 402 until it is paid', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      const checkout = () =>
        u.client.call('/api/billing/checkout', { method: 'POST', json: { amountCents: 500 } });
      expect((await json<ApiError>(await checkout(), 402)).error.code).toBe('membership_required');
      await insertSubscription(env, u.userId, 'active');
      expect((await json<CheckoutResponse>(await checkout())).url).toMatch(
        /^https:\/\/fake-pay\.invalid\/checkout#/,
      );
    });
  });
});
