// ANNUAL_FEE_ENABLED: the yearly membership is
// required to generate only while the flag is on. Off (the default), the
// membership code paths stay but require nothing, whatever the payment
// provider sells: any signed-in user may learn from the pool (within its
// caps), buy personal credit and generate on their own keys. On, generating
// on the user's own keys answers 402 `membership_required` until it is paid,
// in Learn and power mode alike; the pool (with the same caps for everyone,
// members included) and Tangent credit, bought or spent, in either app, stay
// open to everyone.
import type {
  ApiError,
  BillingSummary,
  CheckoutResponse,
  LearnPayment,
  MeResponse,
  PoolMeResponse,
  StreamEvent,
  TreeDetail,
} from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { grantCredit } from '../src/billing/ledger.js';
import { membershipRequired } from '../src/billing/membership.js';
import { appConfig } from '../src/config.js';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AppEnv } from '../src/env.js';
import { makeNode } from './fixtures.js';
import { insertSubscription } from './mocks/billing-helpers.js';
import { poolReadyUser } from './pool-helpers.js';
import { ok, parseSse } from './http.js';

const env = rawEnv as unknown as AppEnv;
/** Billing and the membership sold (the fake provider sells it); only the flag differs. */
const feeEnv = (on: boolean): Partial<AppEnv> => ({
  ANNUAL_FEE_ENABLED: on ? 'true' : 'false',
});

type User = Awaited<ReturnType<typeof poolReadyUser>>;

function lastEvent(text: string): StreamEvent | undefined {
  return parseSse(text).at(-1);
}

/** A power route on Tangent credit: the built-in endpoint, paid from the user's credit. */
const CREDIT = { providerId: 'openrouter', funding: 'credit' } as const;

/**
 * A tree with a user/assistant exchange on its trunk (written directly): in
 * Learn on `learn`, or in power mode without it, on `power` (the fake
 * provider, a user's own key, by default; `CREDIT` is Tangent credit).
 */
async function treeWithNodes(
  u: User,
  learn?: LearnPayment,
  power: { providerId: string; funding?: 'own-key' | 'credit'; model: string } = {
    providerId: 'fake',
    model: 'fake-1',
  },
) {
  const detail = await ok<TreeDetail>(
    await u.client.call(
      '/api/trees',
      learn
        ? { method: 'POST', json: { title: 'T' }, learn }
        : { method: 'POST', json: { title: 'T', ...power } },
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
    // And a server that stores user keys: the membership only unlocks own keys.
    for (const secret of ['', '  ', undefined])
      expect(membershipRequired({ ...env, ...feeEnv(true), KEY_ENCRYPTION_SECRET: secret })).toBe(
        false,
      );
  });

  describe('on and sold, but no user keys can be stored (KEY_ENCRYPTION_SECRET unset)', () => {
    const noKeys: Partial<AppEnv> = { ...feeEnv(true), KEY_ENCRYPTION_SECRET: '' };

    it('requires no membership: /api/me in both apps, and the pricing page sells none', async () => {
      const u = await poolReadyUser({ env: noKeys });
      for (const learn of [undefined, 'pool', 'own-key'] as const) {
        const me = await ok<MeResponse>(await u.client.call('/api/me', learn ? { learn } : {}));
        expect(me.membership, learn).toMatchObject({ required: false, status: 'inactive' });
        expect(me.membershipNeededFor, learn).toEqual([]);
      }
      const pricing = await (await u.client.call('/pricing')).text();
      expect(pricing).toContain('<h1>');
      expect(pricing).not.toMatch(
        /<th scope="col">Your own key<\/th>|yearly membership|a year \+ tax/,
      );
      const sold = await (
        await (await poolReadyUser({ env: feeEnv(true) })).client.call('/pricing')
      ).text();
      expect(sold).toContain('<th scope="col">Your own key</th>');
    });
  });

  describe('off, with the membership price set', () => {
    it('/api/me requires no membership, in both apps', async () => {
      const u = await poolReadyUser({ env: feeEnv(false) });
      for (const learn of [undefined, 'pool'] as const) {
        const me = await ok<MeResponse>(await u.client.call('/api/me', learn ? { learn } : {}));
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
          expect((await ok<ApiError>(res, 429)).error.code).toBe('pool_cap_reached');
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
        expect((await ok<CheckoutResponse>(res)).url).toMatch(
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

    it('a non-member learns from the pool on the same caps as everyone; credit sends move to the pool', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      expect(
        (await ok<MeResponse>(await u.client.call('/api/me', { learn: 'pool' }))).membership,
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
      const me = await ok<PoolMeResponse>(await u.client.call('/api/pool/me', { learn: 'pool' }));
      expect(me).toMatchObject({ caps: { requestsPerDay: 3 } });
      expect(me).not.toHaveProperty('member');
    });

    /** The three generating requests on a tree's trunk: send, review, context resolve. */
    function generating(tree: Awaited<ReturnType<typeof treeWithNodes>>, review: object) {
      return [
        [`/api/branches/${tree.trunk.id}/messages`, { method: 'POST', json: { content: 'Hi' } }],
        [`/api/nodes/${tree.assistant.id}/review`, { method: 'POST', json: review }],
        [`/api/branches/${tree.trunk.id}/context?resolve=true`, {}],
      ] as const;
    }

    it('Learn on their own key needs the membership: 402 for a non-member on every generating route', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      const me = await ok<MeResponse>(await u.client.call('/api/me', { learn: 'own-key' }));
      expect(me.membership).toMatchObject({ required: true, status: 'inactive' });
      expect(me.membershipNeededFor).toEqual(['own-key']);
      const own = await treeWithNodes(u, 'own-key');
      for (const [path, init] of generating(own, { providerId: 'openrouter', model: 'max' })) {
        const res = await u.client.call(path, { ...init, learn: 'own-key' });
        expect((await ok<ApiError>(res, 402)).error.code, path).toBe('membership_required');
      }
      // Reading the lesson stays open.
      expect(
        (await u.client.call(`/api/trees/${own.trunk.treeId}`, { learn: 'own-key' })).status,
      ).toBe(200);
    });

    it('a member learns on their own key', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      await insertSubscription(env, u.userId, 'active');
      const own = await treeWithNodes(u, 'own-key');
      const send = await u.client.call(`/api/branches/${own.trunk.id}/messages`, {
        method: 'POST',
        json: { content: 'Explain primes' },
        learn: 'own-key',
      });
      const text = await send.text();
      expect(send.status, text).toBe(200);
      expect(lastEvent(text)?.type).toBe('done');
      for (const [path, init] of generating(own, { providerId: 'openrouter', model: 'max' })) {
        const res = await u.client.call(path, { ...init, learn: 'own-key' });
        const body = await res.text();
        expect(res.status, `${path} ${body}`).not.toBe(402);
        expect(body, path).not.toContain('membership_required');
      }
    });

    it('402 membership_required for power mode on own keys: sends, reviews and context resolves', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      const power = await treeWithNodes(u);
      for (const [path, init] of generating(power, { providerId: 'fake', model: 'fake-1' })) {
        const res = await u.client.call(path, init);
        expect((await ok<ApiError>(res, 402)).error.code, path).toBe('membership_required');
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

    /** Credit on the user's ledger (an admin grant): spendable whoever holds it. */
    async function grant(u: User, amountMicros = 1_000_000): Promise<void> {
      await grantCredit(env.DB, {
        accountId: `u_${u.userId}`,
        kind: 'adjustment',
        amountMicros,
        providerRef: null,
      });
    }

    async function balanceMicros(u: User): Promise<number> {
      return (await ok<BillingSummary>(await u.client.call('/api/billing'))).balanceMicros;
    }

    for (const who of ['lapsed member', 'never-member'] as const) {
      it(`a ${who} with a balance spends it in both apps and buys more, but can't use own keys`, async () => {
        const u = await poolReadyUser({ env: feeEnv(true) });
        if (who === 'lapsed member') await insertSubscription(env, u.userId, 'canceled');
        await grant(u);
        expect((await ok<MeResponse>(await u.client.call('/api/me'))).membership).toMatchObject({
          required: true,
          status: 'inactive',
        });

        // Power on Tangent credit: allowed, and metered.
        const onCredit = await treeWithNodes(u, undefined, { ...CREDIT, model: 'max' });
        const send = await u.client.call(`/api/branches/${onCredit.trunk.id}/messages`, {
          method: 'POST',
          json: { content: 'Explain primes' },
        });
        const sent = await send.text();
        expect(send.status, sent).toBe(200);
        expect(lastEvent(sent)?.type).toBe('done');
        const afterPower = await balanceMicros(u);
        expect(afterPower).toBeLessThan(1_000_000);

        // Power on an own-key provider: the membership.
        const own = await treeWithNodes(u);
        const refused = await u.client.call(`/api/branches/${own.trunk.id}/messages`, {
          method: 'POST',
          json: { content: 'Hi' },
        });
        expect((await ok<ApiError>(refused, 402)).error.code).toBe('membership_required');

        // Learn on credit spends the credit, not the pool.
        const learn = await treeWithNodes(u, 'credit');
        const learnSend = await u.client.call(`/api/branches/${learn.trunk.id}/messages`, {
          method: 'POST',
          json: { content: 'Explain primes' },
          learn: 'credit',
        });
        const learnText = await learnSend.text();
        expect(learnSend.status, learnText).toBe(200);
        expect(lastEvent(learnText)?.type).toBe('done');
        expect(await balanceMicros(u)).toBeLessThan(afterPower);
        const review = await u.client.call(`/api/nodes/${learn.assistant.id}/review`, {
          method: 'POST',
          json: { providerId: 'openrouter', model: 'max' },
          learn: 'credit',
        });
        expect(review.status, await review.text()).toBe(200);

        // Learn on an own key: the membership too.
        const ownLearn = await treeWithNodes(u, 'own-key');
        const ownLearnSend = await u.client.call(`/api/branches/${ownLearn.trunk.id}/messages`, {
          method: 'POST',
          json: { content: 'Hi' },
          learn: 'own-key',
        });
        expect((await ok<ApiError>(ownLearnSend, 402)).error.code).toBe('membership_required');

        // Buying more needs no membership; the pool has the same caps as for everyone.
        const checkout = await u.client.call('/api/billing/checkout', {
          method: 'POST',
          json: { amountCents: 500 },
        });
        expect((await ok<CheckoutResponse>(checkout)).url).toMatch(
          /^https:\/\/fake-pay\.invalid\/checkout#/,
        );
        expect(
          await ok<PoolMeResponse>(await u.client.call('/api/pool/me', { learn: 'pool' })),
        ).toMatchObject({ caps: { requestsPerDay: 3 } });
      });
    }

    it('a non-member without a balance: 402 payment_required on credit, in power and Learn', async () => {
      const u = await poolReadyUser({ env: { ...feeEnv(true), POOL_ENABLED: 'false' } });
      const power = await treeWithNodes(u, undefined, { ...CREDIT, model: 'max' });
      for (const [path, init] of generating(power, { ...CREDIT, model: 'max' })) {
        const res = await u.client.call(path, init);
        expect((await ok<ApiError>(res, 402)).error.code, path).toBe('payment_required');
      }
      // With the pool off a Learn credit send can't move to it either.
      const credit = await treeWithNodes(u, 'credit');
      for (const [path, init] of generating(credit, { providerId: 'openrouter', model: 'max' })) {
        const res = await u.client.call(path, { ...init, learn: 'credit' });
        expect((await ok<ApiError>(res, 402)).error.code, path).toBe('payment_required');
      }
    });

    it('a power review that calls an own key anywhere needs the membership, balance or not', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      await grant(u);
      const review = (
        nodeId: string,
        route: { providerId: string; funding?: 'own-key' | 'credit' },
        model: string,
      ) =>
        u.client.call(`/api/nodes/${nodeId}/review`, {
          method: 'POST',
          json: { ...route, model },
        });
      // Reviewer on credit, the branch (and its summaries) on an own key.
      const own = await treeWithNodes(u);
      expect(
        (await ok<ApiError>(await review(own.assistant.id, CREDIT, 'max'), 402)).error.code,
      ).toBe('membership_required');
      // Reviewer on an own key, the branch on credit.
      const onCredit = await treeWithNodes(u, undefined, { ...CREDIT, model: 'max' });
      expect(
        (
          await ok<ApiError>(
            await review(onCredit.assistant.id, { providerId: 'fake' }, 'fake-1'),
            402,
          )
        ).error.code,
      ).toBe('membership_required');
      // Both on credit: fine.
      const both = await review(onCredit.assistant.id, CREDIT, 'max');
      expect(both.status, await both.text()).toBe(200);
      // A member may mix.
      await insertSubscription(env, u.userId, 'active');
      const mixed = await review(own.assistant.id, CREDIT, 'max');
      expect(mixed.status, await mixed.text()).toBe(200);
    });

    it('a member gets the same pool caps as everyone (3 replies a day in the tests)', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      await insertSubscription(env, u.userId, 'active');
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push(await sendStatus(u, 'pool', `Q${i}`));
      expect(statuses).toEqual([200, 200, 200, 429]);
      expect(
        await ok<PoolMeResponse>(await u.client.call('/api/pool/me', { learn: 'pool' })),
      ).toMatchObject({ caps: { requestsPerDay: 3, usedRequests: 3 } });
    });

    it('a waived user is a member: Learn on their own key is open', async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      await env.DB.prepare('UPDATE auth_users SET membership_waived = 1 WHERE id = ?')
        .bind(u.userId)
        .run();
      expect(
        (await ok<MeResponse>(await u.client.call('/api/me', { learn: 'own-key' }))).membership,
      ).toMatchObject({ required: true, status: 'waived' });
      expect(await sendStatus(u, 'own-key')).toBe(200);
    });

    it('with no pool and no credit for sale, the membership is the only way to reply in Learn: own-key sends are 402 membership_required', async () => {
      const u = await poolReadyUser({
        env: { ...feeEnv(true), POOL_ENABLED: 'false', FAKE_PAYMENTS: '{"topUps":false}' },
      });
      const me = await ok<MeResponse>(await u.client.call('/api/me', { learn: 'own-key' }));
      expect(me.membership).toMatchObject({ required: true, status: 'inactive' });
      expect(me.membershipNeededFor).toEqual(['own-key']);
      const own = await treeWithNodes(u, 'own-key');
      const send = await u.client.call(`/api/branches/${own.trunk.id}/messages`, {
        method: 'POST',
        json: { content: 'Hi' },
        learn: 'own-key',
      });
      // Intended: no free or paid alternative here, so the membership is what unlocks Learn.
      expect((await ok<ApiError>(send, 402)).error.code).toBe('membership_required');
      // Credit (none granted, none for sale) can't pay either.
      expect(await sendStatus(u, 'credit')).toBe(402);
    });

    it('the fee on but the membership not sold: a Learn own-key send is never refused for it', async () => {
      const u = await poolReadyUser({
        env: { ...feeEnv(true), FAKE_PAYMENTS: JSON.stringify({ membership: false }) },
      });
      const me = await ok<MeResponse>(await u.client.call('/api/me', { learn: 'own-key' }));
      expect(me.membership).toMatchObject({ required: false });
      expect(me.membershipNeededFor).toEqual([]);
      const own = await treeWithNodes(u, 'own-key');
      const send = await u.client.call(`/api/branches/${own.trunk.id}/messages`, {
        method: 'POST',
        json: { content: 'Hi' },
        learn: 'own-key',
      });
      const body = await send.text();
      expect(send.status, body).not.toBe(402);
      expect(body).not.toContain('membership_required');
    });

    it("anyone may buy credit: a non-member's checkout opens, in either app", async () => {
      const u = await poolReadyUser({ env: feeEnv(true) });
      for (const learn of [undefined, 'pool'] as const) {
        const res = await u.client.call('/api/billing/checkout', {
          method: 'POST',
          json: { amountCents: 500 },
          ...(learn ? { learn } : {}),
        });
        expect((await ok<CheckoutResponse>(res)).url).toMatch(
          /^https:\/\/fake-pay\.invalid\/checkout#/,
        );
      }
    });
  });
});
