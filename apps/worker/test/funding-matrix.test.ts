import {
  type ApiError,
  type Branch,
  type LearnPayment,
  type MeResponse,
  type ProviderInfo,
  type StreamEvent,
  type TreeDetail,
} from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { grantCredit } from '../src/billing/ledger.js';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AppEnv } from '../src/env.js';
import { simpleProviderConfig } from '../src/simple-mode.js';
import { makeNode } from './fixtures.js';
import { insertSubscription } from './mocks/billing-helpers.js';
import { poolReadyUser } from './pool-helpers.js';
import { authEnv, client, type CallInit } from './session-client.js';

/**
 * Who pays, and whose key is used, now that a provider id names only the
 * endpoint and funding is decided apart from it (docs/DECISIONS.md, "Funding
 * apart from the provider"). Every scenario that existed when `tangent` was a
 * provider id keeps the same payer and the same key:
 *
 * | scenario                  | key used               | metered on            |
 * | ------------------------- | ---------------------- | --------------------- |
 * | Learn, own key            | the user's OpenRouter  | nothing               |
 * | Learn, credit             | the operator's         | the user's ledger     |
 * | Learn, pool               | the operator's         | the pool (pinned)     |
 * | power, own keys           | the user's             | nothing (membership)  |
 * | power, Tangent credit     | the operator's         | the user's ledger     |
 * | self-hosted, no billing   | the user's (no credit) | nothing               |
 * | dev bypass                | server secrets / op.   | the dev ledger        |
 *
 * Reviews stream from the Worker, so they run with each test's env and show
 * which key replied (the mock upstream answers `key=<tag>`, see
 * vitest.config.ts); they go through the same gate and registries as sends.
 */

const env = rawEnv as unknown as AppEnv;
const MOCK_UPSTREAM = 'https://llm.test';
const USER_KEY = 'sk-ant-goodUSER-0123456789';
const MODELS = [
  { id: 'max', label: 'Max', tier: 'max' },
  { id: 'normal', label: 'Normal', tier: 'normal' },
];

/** An OpenRouter-like endpoint on the mock upstream, keyed by `secret` (or a user key). */
function openRouterLike(label: string, secret: string) {
  return {
    id: 'openrouter',
    kind: 'anthropic',
    label,
    baseUrl: MOCK_UPSTREAM,
    apiKeySecret: secret,
    defaultModel: 'max',
    models: MODELS,
  };
}

/**
 * Power has its own `openrouter` (the user's key; the server's OPENROUTER_API_KEY only for
 * the dev bypass); the built-in provider is the same endpoint on the operator's key.
 */
function matrixEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return authEnv({
    PROVIDERS: JSON.stringify([
      {
        id: 'fake',
        kind: 'fake',
        label: 'Fake',
        defaultModel: 'fake-1',
        models: [{ id: 'fake-1', label: 'Fake 1' }],
      },
      openRouterLike('OpenRouter', 'OPENROUTER_API_KEY'),
    ]),
    SIMPLE_PROVIDER: JSON.stringify(openRouterLike('Tangent', 'OPENROUTER_SIMPLE_API_KEY')),
    OPENROUTER_SIMPLE_API_KEY: 'sk-ant-goodOPERATOR',
    OPENROUTER_API_KEY: 'sk-ant-goodSERVER',
    ...overrides,
  });
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

function replyOf(text: string): string {
  return text
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as StreamEvent)
    .map((ev) => (ev.type === 'delta' ? ev.text : ''))
    .join('');
}

async function usageRows(accountId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM usage_events WHERE account_id = ?1 AND purpose <> 'tagging'",
  )
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

type Client = ReturnType<typeof client>;
type Route = { providerId: string; funding?: 'own-key' | 'credit' };

let seq = 0;
async function signedIn(e: AppEnv): Promise<{ c: Client; userId: string }> {
  const c = client(e);
  await c.signIn(`matrix${++seq}-${Math.random().toString(36).slice(2, 8)}@example.org`);
  const me = await json<MeResponse>(await c.call('/api/me'));
  return { c, userId: me.userId! };
}

async function saveOwnOpenRouterKey(c: Client, learn?: LearnPayment): Promise<void> {
  const res = await c.call('/api/key', {
    method: 'POST',
    json: { provider: 'openrouter', apiKey: USER_KEY },
    ...(learn ? { learn } : {}),
  });
  expect(res.status, await res.text()).toBe(204);
}

async function grant(accountId: string, micros = 1_000_000): Promise<void> {
  await grantCredit(env.DB, {
    accountId,
    kind: 'adjustment',
    amountMicros: micros,
    providerRef: null,
  });
}

/** A tree on `route` with a finished exchange; returns the reply to review. */
async function replyOn(c: Client, route: Route, learn?: LearnPayment, as?: AppEnv) {
  const detail = await json<TreeDetail>(
    await c.call(
      '/api/trees',
      {
        method: 'POST',
        json: { title: 'M', ...route, model: 'max' },
        ...(learn ? { learn } : {}),
      },
      as,
    ),
    201,
  );
  const trunk = detail.branches[0]!;
  const user = makeNode(trunk, 0, null, { role: 'user', content: 'Q' });
  const assistant = makeNode(trunk, 1, user.id, { role: 'assistant', content: 'A' });
  await createD1Repositories(env.DB).trees.appendNodes([user, assistant], new Date().toISOString());
  return { trunk, assistant };
}

/** Reviews `nodeId` with a reviewer on `route`: who answered (`key=<tag>`) and the status. */
async function reviewWith(
  c: Client,
  nodeId: string,
  route: Route,
  init: CallInit = {},
  as?: AppEnv,
): Promise<{ status: number; reply: string; code: string | null }> {
  const res = await c.call(
    `/api/nodes/${nodeId}/review`,
    { method: 'POST', json: { ...route, model: 'max' }, ...init },
    as,
  );
  const text = await res.text();
  if (res.status !== 200)
    return { status: res.status, reply: '', code: (JSON.parse(text) as ApiError).error.code };
  return { status: 200, reply: replyOf(text), code: null };
}

const OWN: Route = { providerId: 'openrouter', funding: 'own-key' };
const CREDIT: Route = { providerId: 'openrouter', funding: 'credit' };

describe('funding matrix: who pays, and with which key', () => {
  it("Learn on its own key: the user's OpenRouter key, never metered, whatever a branch's funding", async () => {
    const e = matrixEnv();
    const { c, userId } = await signedIn(e);
    await grant(`u_${userId}`); // credit held, and still not touched
    const { trunk, assistant } = await replyOn(c, { providerId: 'openrouter' }, 'own-key');
    expect(trunk.funding).toBe('own-key');

    // No key yet: asked for one; the operator's key is never the fallback.
    expect(await reviewWith(c, assistant.id, OWN, { learn: 'own-key' })).toMatchObject({
      status: 401,
      code: 'key_required',
    });
    await saveOwnOpenRouterKey(c, 'own-key');
    for (const route of [OWN, CREDIT]) {
      expect(await reviewWith(c, assistant.id, route, { learn: 'own-key' })).toEqual({
        status: 200,
        reply: 'key=USER-0123456789',
        code: null,
      });
    }
    expect(await usageRows(`u_${userId}`)).toBe(0);
  });

  it("Learn on credit: the operator's key, metered to the user's ledger, never the user's key", async () => {
    const e = matrixEnv({ POOL_ENABLED: 'false' });
    const { c, userId } = await signedIn(e);
    await saveOwnOpenRouterKey(c, 'own-key');
    const { assistant } = await replyOn(c, { providerId: 'openrouter' }, 'credit');
    // No balance: 402, not the user's key.
    expect(await reviewWith(c, assistant.id, OWN, { learn: 'credit' })).toMatchObject({
      status: 402,
      code: 'payment_required',
    });
    await grant(`u_${userId}`);
    // A branch or reviewer funding means nothing in Learn: the payment header decides.
    for (const route of [OWN, CREDIT]) {
      expect(await reviewWith(c, assistant.id, route, { learn: 'credit' })).toMatchObject({
        status: 200,
        reply: 'key=OPERATOR',
      });
    }
    expect(await usageRows(`u_${userId}`)).toBe(2);
  });

  it('Learn on the pool: the pinned model and locked prompt, charged to the pool, never the user', async () => {
    const u = await poolReadyUser({ env: { POOL_SYSTEM_PROMPT: 'LOCKED POOL PROMPT' } });
    const detail = await json<TreeDetail>(
      await u.client.call('/api/trees', {
        method: 'POST',
        json: { title: 'P', systemPrompt: 'IGNORE ME', model: 'max', funding: 'credit' },
        learn: 'pool',
      }),
      201,
    );
    const trunk = detail.branches[0]!;
    // Learn writes `own-key` whatever it is asked: its payment is per request.
    expect(trunk).toMatchObject({ providerId: 'openrouter', funding: 'own-key' });
    const patched = await json<Branch>(
      await u.client.call(`/api/branches/${trunk.id}`, {
        method: 'PATCH',
        json: { funding: 'credit' },
        learn: 'pool',
      }),
    );
    expect(patched.funding).toBe('own-key');

    const res = await u.client.call(`/api/branches/${trunk.id}/messages`, {
      method: 'POST',
      json: { content: 'Explain primes [echo-request]' },
      learn: 'pool',
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const echoed = replyOf(text);
    expect(echoed).toMatch(/^ECHO model=normal maxOutputTokens=2048 /);
    expect(echoed).toContain('LOCKED POOL PROMPT');
    expect(echoed).not.toContain('IGNORE ME');
    expect(await usageRows(u.poolId)).toBe(1);
    expect(await usageRows(`u_${u.userId}`)).toBe(0);
  });

  it("power on its own keys: the user's key, never the operator's, never metered", async () => {
    const e = matrixEnv();
    const { c, userId } = await signedIn(e);
    await grant(`u_${userId}`);
    const { trunk, assistant } = await replyOn(c, OWN);
    expect(trunk).toMatchObject({ providerId: 'openrouter', funding: 'own-key' });
    // A provider named without a funding is on the user's own key too.
    const plain = await replyOn(c, { providerId: 'openrouter' });
    expect(plain.trunk.funding).toBe('own-key');

    expect(await reviewWith(c, assistant.id, OWN)).toMatchObject({
      status: 401,
      code: 'key_required',
    });
    await saveOwnOpenRouterKey(c);
    expect(await reviewWith(c, assistant.id, OWN)).toEqual({
      status: 200,
      reply: 'key=USER-0123456789',
      code: null,
    });
    expect(await usageRows(`u_${userId}`)).toBe(0);
  });

  it("power on Tangent credit: the operator's key, metered, even with the user's key for the same endpoint", async () => {
    const e = matrixEnv();
    const { c, userId } = await signedIn(e);
    await saveOwnOpenRouterKey(c);
    const { trunk, assistant } = await replyOn(c, CREDIT);
    expect(trunk).toMatchObject({ providerId: 'openrouter', funding: 'credit' });
    expect(await reviewWith(c, assistant.id, CREDIT)).toMatchObject({
      status: 402,
      code: 'payment_required',
    });
    await grant(`u_${userId}`);
    expect(await reviewWith(c, assistant.id, CREDIT)).toEqual({
      status: 200,
      reply: 'key=OPERATOR',
      code: null,
    });
    expect(await usageRows(`u_${userId}`)).toBe(1);
    // The same endpoint on the user's key, from the same branch, stays theirs and free.
    const own = await replyOn(c, OWN);
    expect(await reviewWith(c, own.assistant.id, OWN)).toMatchObject({
      reply: 'key=USER-0123456789',
    });
    expect(await usageRows(`u_${userId}`)).toBe(1);
  });

  it('the membership gates own keys in both apps; credit never needs it', async () => {
    const e = matrixEnv({ ANNUAL_FEE_ENABLED: 'true', POOL_ENABLED: 'false' });
    const { c, userId } = await signedIn(e);
    await grant(`u_${userId}`);
    await saveOwnOpenRouterKey(c);
    const own = await replyOn(c, OWN);
    expect(await reviewWith(c, own.assistant.id, OWN)).toMatchObject({
      status: 402,
      code: 'membership_required',
    });
    const credit = await replyOn(c, CREDIT);
    expect(await reviewWith(c, credit.assistant.id, CREDIT)).toMatchObject({
      status: 200,
      reply: 'key=OPERATOR',
    });
    const learn = await replyOn(c, { providerId: 'openrouter' }, 'own-key');
    expect(await reviewWith(c, learn.assistant.id, OWN, { learn: 'own-key' })).toMatchObject({
      status: 402,
      code: 'membership_required',
    });
    // Learn on credit: the operator's key, no membership.
    expect(await reviewWith(c, learn.assistant.id, OWN, { learn: 'credit' })).toMatchObject({
      status: 200,
      reply: 'key=OPERATOR',
    });
    // A member's Learn own-key review runs on their key.
    await insertSubscription(env, userId, 'active');
    expect(await reviewWith(c, learn.assistant.id, OWN, { learn: 'own-key' })).toMatchObject({
      status: 200,
      reply: 'key=USER-0123456789',
    });
  });

  it('self-hosted without billing: no Tangent credit in power, Learn credit falls back to the own key', async () => {
    const e = matrixEnv({ PAYMENT_PROVIDER: 'polar', POOL_ENABLED: 'false' });
    const { c, userId } = await signedIn(e);
    await saveOwnOpenRouterKey(c);
    const providers = await json<ProviderInfo[]>(await c.call('/api/providers'));
    expect(providers.map((p) => `${p.id}:${p.funding}`)).toEqual([
      'fake:own-key',
      'openrouter:own-key',
    ]);
    // A credit route can't be created or used: refused, never the operator's key.
    const refused = await c.call('/api/trees', { method: 'POST', json: { ...CREDIT } });
    expect(refused.status).toBe(400);
    const own = await replyOn(c, OWN);
    expect(await reviewWith(c, own.assistant.id, CREDIT)).toMatchObject({
      status: 400,
      code: 'bad_request',
    });
    // Learn asking for credit gets its own key.
    const learn = await replyOn(c, { providerId: 'openrouter' }, 'credit');
    expect(await reviewWith(c, learn.assistant.id, OWN, { learn: 'credit' })).toMatchObject({
      status: 200,
      reply: 'key=USER-0123456789',
    });
    expect(await usageRows(`u_${userId}`)).toBe(0);
  });

  it('the dev bypass: power own-key routes on server secrets, credit on the operator key, metered', async () => {
    const devEnv = matrixEnv({ BETTER_AUTH_SECRET: '', DEV_ALLOW_NO_AUTH: 'true' });
    const dev = client(devEnv);
    const before = await usageRows('default_simple');
    await grant('default_simple');
    const own = await replyOn(dev, OWN, undefined, devEnv);
    expect(await reviewWith(dev, own.assistant.id, OWN, {}, devEnv)).toMatchObject({
      status: 200,
      reply: 'key=SERVER',
    });
    expect(await usageRows('default_simple')).toBe(before);
    const credit = await replyOn(dev, CREDIT, undefined, devEnv);
    expect(await reviewWith(dev, credit.assistant.id, CREDIT, {}, devEnv)).toMatchObject({
      status: 200,
      reply: 'key=OPERATOR',
    });
    expect(await usageRows('default_simple')).toBe(before + 1);
    // Learn in the dev bypass never falls back to the operator's key on its own key.
    const learn = await replyOn(dev, { providerId: 'openrouter' }, 'own-key', devEnv);
    expect(
      await reviewWith(dev, learn.assistant.id, OWN, { learn: 'own-key' }, devEnv),
    ).toMatchObject({ status: 401, code: 'key_required' });
  });
});

describe('the provider id `tangent`', () => {
  it('is an unknown provider: SIMPLE_PROVIDER may not use it, and a request naming it is refused', async () => {
    const named = {
      ...env,
      SIMPLE_PROVIDER: JSON.stringify({ ...openRouterLike('Tangent', 'X'), id: 'tangent' }),
    } as AppEnv;
    expect(() => simpleProviderConfig(named)).toThrow(/id must be "openrouter"/);
    const { c } = await signedIn(authEnv());
    const res = await c.call('/api/trees', {
      method: 'POST',
      json: { providerId: 'tangent', model: 'max' },
    });
    expect(await res.json()).toEqual({
      error: { code: 'bad_request', message: 'Unknown provider "tangent"' },
    });
    expect(res.status).toBe(400);
  });
});
