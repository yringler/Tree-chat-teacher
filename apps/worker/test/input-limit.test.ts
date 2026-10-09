import type {
  ContextPlanResponse,
  InputBudgetResponse,
  StreamEvent,
  TreeDetail,
} from '@tangent/shared';
import { ChatService } from '@tangent/core';
import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { grantCredit } from '../src/billing/ledger.js';
import type { AccountContext, AppEnv } from '../src/env.js';
import { generationLimits, serverInputCap } from '../src/input-limit.js';
import { simpleMaxInputTokens } from '../src/simple-mode.js';
import { uniq } from './mocks/billing-helpers.js';
import { authEnv, client } from './session-client.js';
import { call, parseSse } from './http.js';

/**
 * Power's input limit (`SendMessageRequest.maxInputTokens`, `.inputOverflow`):
 * sent with each message and with the Context preview, clamped to the model's
 * window less the reply, and on Tangent credit to BUILT_IN_MAX_INPUT_TOKENS.
 */
const env = rawEnv as unknown as AppEnv;
const CREDIT_CAP = simpleMaxInputTokens(env);

async function trunk(route: Record<string, string>): Promise<string> {
  const res = await call('/api/trees', { json: { title: 'Limit', ...route } });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as TreeDetail).tree.trunkBranchId;
}

async function budgetOf(branchId: string, query: Record<string, string> = {}): Promise<number> {
  const q = new URLSearchParams(query).toString();
  const res = await call(`/api/branches/${branchId}/context${q ? `?${q}` : ''}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as ContextPlanResponse).plan.budget.maxInputTokens;
}

function account(mode: 'power' | 'simple'): AccountContext {
  return {
    id: 'a',
    mode,
    userId: null,
    billingAccountId: 'b',
    builtIn: true,
    operatorKeys: true,
    funding: 'credit',
  };
}

describe('generationLimits', () => {
  it('passes power’s own-key limits through: only the model’s window bounds them', () => {
    const power = account('power');
    expect(serverInputCap(env, power, 'own-key')).toBeNull();
    expect(generationLimits(env, power, 'own-key', {})).toEqual({});
    expect(
      generationLimits(env, power, 'own-key', {
        maxInputTokens: 500_000,
        maxOutputTokens: 8192,
        inputOverflow: 'truncate',
      }),
    ).toEqual({ maxInputTokens: 500_000, maxOutputTokens: 8192, inputOverflow: 'truncate' });
    // Compacting is the default: not sent.
    expect(generationLimits(env, power, 'own-key', { inputOverflow: 'compact' })).toEqual({});
  });

  it('caps Tangent credit at the server’s input cap, with or without a setting', () => {
    const power = account('power');
    expect(CREDIT_CAP).toBe(60_000);
    expect(serverInputCap(env, power, 'credit')).toBe(CREDIT_CAP);
    expect(generationLimits(env, power, 'credit', {})).toEqual({ maxInputTokens: CREDIT_CAP });
    expect(generationLimits(env, power, 'credit', { maxInputTokens: 200_000 })).toEqual({
      maxInputTokens: CREDIT_CAP,
    });
    expect(generationLimits(env, power, 'credit', { maxInputTokens: 20_000 })).toEqual({
      maxInputTokens: 20_000,
    });
  });

  it('ignores everything in Learn (its own caps apply)', () => {
    const learn = account('simple');
    expect(serverInputCap(env, learn, 'credit')).toBeNull();
    expect(
      generationLimits(env, learn, 'credit', {
        maxInputTokens: 2000,
        maxOutputTokens: 1000,
        inputOverflow: 'truncate',
      }),
    ).toEqual({});
  });
});

describe('power: the Context preview plans with the limits', () => {
  it('on the own key: the window less the reply, lowered by the limit, never raised', async () => {
    const branchId = await trunk({ providerId: 'fake' });
    // The fake provider: a 200,000-token window, 4,096 out.
    expect(await budgetOf(branchId)).toBe(200_000 - 4096);
    expect(await budgetOf(branchId, { maxInputTokens: '5000' })).toBe(5000);
    expect(await budgetOf(branchId, { maxInputTokens: '2000000' })).toBe(200_000 - 4096);
    expect(await budgetOf(branchId, { maxOutputTokens: '1000' })).toBe(200_000 - 1000);
  });

  it('on Tangent credit: never above the server’s cap', async () => {
    const branchId = await trunk({ providerId: 'openrouter', funding: 'credit', model: 'normal' });
    expect(await budgetOf(branchId)).toBe(CREDIT_CAP);
    expect(await budgetOf(branchId, { maxInputTokens: '200000' })).toBe(CREDIT_CAP);
    expect(await budgetOf(branchId, { maxInputTokens: '20000' })).toBe(20_000);
  });

  it('rejects limits out of range', async () => {
    const branchId = await trunk({ providerId: 'fake' });
    for (const query of [
      'maxInputTokens=10',
      'maxInputTokens=3000000',
      'maxInputTokens=1.5',
      'maxInputTokens=lots',
      'maxOutputTokens=10',
      'inputOverflow=forget',
    ]) {
      const res = await call(`/api/branches/${branchId}/context?${query}`);
      expect(res.status, query).toBe(400);
      await res.text();
    }
  });
});

describe('power: a send with an input limit', () => {
  async function send(branchId: string, json: Record<string, unknown>) {
    const res = await call(`/api/branches/${branchId}/messages`, { json });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    return parseSse(text);
  }

  it('drops the oldest messages for truncate, and compacts them by default', async () => {
    const long = 'x'.repeat(7000); // 2,000 tokens at 3.5 chars a token
    const branchId = await trunk({ providerId: 'fake' });
    for (const n of [1, 2, 3]) await send(branchId, { content: `${n} ${long}` });
    // The fake replies "… to N message(s)": what was sent.
    const sentCount = (evs: StreamEvent[]) => {
      const reply = evs.map((e) => (e.type === 'delta' ? e.text : '')).join('');
      return Number(/to (\d+) message/.exec(reply)?.[1]);
    };
    const all = await send(branchId, { content: 'Q1' });
    expect(sentCount(all)).toBe(7);
    const truncated = await send(branchId, {
      content: 'Q2',
      maxInputTokens: 3000,
      inputOverflow: 'truncate',
    });
    expect(truncated.some((e) => e.type === 'status' && /Compacting/.test(e.message))).toBe(false);
    expect(sentCount(truncated)).toBeLessThan(9);
    const compacted = await send(branchId, { content: 'Q3', maxInputTokens: 3000 });
    expect(compacted.some((e) => e.type === 'status' && /Compacting/.test(e.message))).toBe(true);
  });

  it('rejects a limit out of range or an unknown over-limit choice', async () => {
    const branchId = await trunk({ providerId: 'fake' });
    for (const extra of [
      { maxInputTokens: 999 },
      { maxInputTokens: 2_000_001 },
      { maxInputTokens: '60000' },
      { inputOverflow: 'forget' },
    ]) {
      const res = await call(`/api/branches/${branchId}/messages`, {
        json: { content: 'Hi', ...extra },
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      await res.text();
    }
  });
});

describe('GET /api/branches/:id/input-budget', () => {
  it('reports the window, the server cap and, on credit, what credit charges', async () => {
    const own = await trunk({ providerId: 'fake' });
    const res = await call(`/api/branches/${own}/input-budget`);
    expect(res.status).toBe(200);
    expect((await res.json()) as InputBudgetResponse).toEqual({
      model: 'fake-1',
      funding: 'own-key',
      contextTokens: 200_000,
      maxOutputTokens: 4096,
      reasoning: false,
      serverMaxInputTokens: null,
      price: null,
    });

    // `simple` is priced at 1 µ$ a token each way (vitest.config.ts MODEL_PRICES); credit
    // charges it with OpenRouter's fee (5.5%) and the markup (10%), as billing does.
    const credit = await trunk({ providerId: 'openrouter', funding: 'credit', model: 'normal' });
    const body = (await (
      await call(`/api/branches/${credit}/input-budget`)
    ).json()) as InputBudgetResponse;
    expect(body).toMatchObject({
      model: 'normal',
      funding: 'credit',
      serverMaxInputTokens: CREDIT_CAP,
      price: { inputUsdPerMTok: 1.1605, cacheReadUsdPerMTok: null, basis: 'credit' },
    });
  });
});

describe('Compare candidates and reviews take the limits like a send', () => {
  afterEach(() => vi.restoreAllMocks());

  const frames = (text: string) =>
    parseSse<{ type: string; message?: string; text?: string }>(text);
  const compacting = (evs: { type: string; message?: string }[]) =>
    evs.some((e) => e.type === 'status' && /Compacting/.test(e.message ?? ''));

  /** A power branch on the own key with three long exchanges (the fake: a 200,000 window). */
  async function longBranch(): Promise<{ branchId: string; replyId: string }> {
    const long = 'x'.repeat(7000); // 2,000 tokens at 3.5 chars a token
    const res = await call('/api/trees', { json: { title: 'Limit', providerId: 'fake' } });
    expect(res.status).toBe(201);
    const { tree } = (await res.json()) as TreeDetail;
    const branchId = tree.trunkBranchId;
    for (const n of [1, 2, 3]) {
      const sent = await call(`/api/branches/${branchId}/messages`, {
        json: { content: `${n} ${long}` },
      });
      expect(sent.status).toBe(200);
      await sent.text();
    }
    const detail = (await (await call(`/api/trees/${tree.id}`)).json()) as TreeDetail;
    const replies = detail.nodes.filter((n) => n.role === 'assistant');
    const replyId = replies.sort((a, b) => a.seq - b.seq).at(-1)!.id;
    return { branchId, replyId };
  }

  it('a candidate on the own key: compacts or drops over the limit', async () => {
    const { branchId } = await longBranch();
    const ask = async (extra: Record<string, unknown>) => {
      const res = await call(`/api/branches/${branchId}/candidates`, {
        json: { content: 'Q', providerId: 'fake', model: 'fake-1', ...extra },
      });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      return frames(text);
    };
    expect(compacting(await ask({}))).toBe(false);
    expect(compacting(await ask({ maxInputTokens: 3000, inputOverflow: 'truncate' }))).toBe(false);
    expect(compacting(await ask({ maxInputTokens: 3000 }))).toBe(true);
  });

  it('a review on the own key: compacts what the reviewer reads over the limit', async () => {
    const { replyId } = await longBranch();
    const review = async (extra: Record<string, unknown>) => {
      const res = await call(`/api/nodes/${replyId}/review`, {
        json: { providerId: 'fake', model: 'fake-1', ...extra },
      });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      return frames(text);
    };
    expect(compacting(await review({}))).toBe(false);
    // Room for the system prompt (about 1,000), a summary (1,024) and the reviewed
    // exchange (about 2,000), not for the whole path (about 7,000).
    expect(compacting(await review({ maxInputTokens: 5000, inputOverflow: 'truncate' }))).toBe(
      false,
    );
    expect(compacting(await review({ maxInputTokens: 5000 }))).toBe(true);
  });

  it('rejects limits out of range on both', async () => {
    const { branchId, replyId } = await longBranch();
    for (const extra of [
      { maxInputTokens: 999 },
      { maxOutputTokens: 10 },
      { inputOverflow: 'x' },
    ]) {
      const c = await call(`/api/branches/${branchId}/candidates`, {
        json: { content: 'Q', providerId: 'fake', model: 'fake-1', ...extra },
      });
      expect(c.status, JSON.stringify(extra)).toBe(400);
      await c.text();
      const r = await call(`/api/nodes/${replyId}/review`, {
        json: { providerId: 'fake', model: 'fake-1', ...extra },
      });
      expect(r.status, JSON.stringify(extra)).toBe(400);
      await r.text();
    }
  });

  it('clamps them on the route that runs: credit at the server cap, own key as asked, Learn none', async () => {
    // The dev bypass's credit (its ledger is `default_simple`), so the credit routes pass the gate.
    await grantCredit(env.DB, {
      accountId: 'default_simple',
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
    });
    const candidates = vi.spyOn(ChatService.prototype, 'prepareCandidate');
    const reviews = vi.spyOn(ChatService.prototype, 'prepareReview');
    const { branchId, replyId } = await longBranch();
    const asked = { maxInputTokens: 200_000, maxOutputTokens: 2000, inputOverflow: 'truncate' };

    // The candidate's own route decides, not the branch's (here own key).
    for (const [route, want] of [
      [{ providerId: 'fake', model: 'fake-1' }, asked],
      [
        { providerId: 'openrouter', funding: 'credit', model: 'normal' },
        { ...asked, maxInputTokens: CREDIT_CAP },
      ],
    ] as const) {
      const res = await call(`/api/branches/${branchId}/candidates`, {
        json: { content: 'Q', ...route, ...asked },
      });
      await res.text();
      expect(candidates.mock.calls.at(-1)?.[2], JSON.stringify(route)).toEqual(want);
    }
    // A credit reviewer of an own-key reply: the reviewer reads, so its cap applies,
    // with or without a setting.
    for (const [extra, want] of [
      [asked, { ...asked, maxInputTokens: CREDIT_CAP }],
      [{}, { maxInputTokens: CREDIT_CAP }],
    ] as const) {
      const res = await call(`/api/nodes/${replyId}/review`, {
        json: { providerId: 'openrouter', funding: 'credit', model: 'normal', ...extra },
      });
      await res.text();
      expect(reviews.mock.calls.at(-1)?.[2]).toEqual(want);
    }

    // Learn sends none and takes none.
    const c = client(authEnv());
    await c.signIn(`limits-${uniq('u')}@example.org`);
    const me = (await (await c.call('/api/me')).json()) as { userId: string };
    await grantCredit(env.DB, {
      accountId: `u_${me.userId}`,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
    });
    const lesson = (await (
      await c.call('/api/trees', { method: 'POST', json: { title: 'L' }, learn: 'credit' })
    ).json()) as TreeDetail;
    const res = await c.call(`/api/branches/${lesson.tree.trunkBranchId}/candidates`, {
      method: 'POST',
      json: { content: 'Q', model: 'normal', ...asked },
      learn: 'credit',
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(candidates.mock.calls.at(-1)?.[2]).toEqual({});
  });
});
