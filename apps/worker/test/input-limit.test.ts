import type {
  ContextPlanResponse,
  InputBudgetResponse,
  StreamEvent,
  TreeDetail,
} from '@tangent/shared';
import { env as rawEnv, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { AccountContext, AppEnv } from '../src/env.js';
import { generationLimits, serverInputCap } from '../src/input-limit.js';
import { simpleMaxInputTokens } from '../src/simple-mode.js';

/**
 * Power's input limit (`SendMessageRequest.maxInputTokens`, `.inputOverflow`):
 * sent with each message and with the Context preview, clamped to the model's
 * window less the reply, and on Tangent credit to SIMPLE_MAX_INPUT_TOKENS.
 */
const env = rawEnv as unknown as AppEnv;
const BASE = 'https://tangent.example.com';
const CREDIT_CAP = simpleMaxInputTokens(env);

function call(path: string, init: { method?: string; json?: unknown } = {}): Promise<Response> {
  return exports.default.fetch(
    new Request(BASE + path, {
      method: init.method ?? (init.json === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json' },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
    }),
  );
}

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
    funding: 'personal',
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
    const branchId = await trunk({ providerId: 'openrouter', funding: 'credit', model: 'simple' });
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
  function events(text: string): StreamEvent[] {
    return text
      .split('\n\n')
      .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
      .filter((l): l is string => !!l)
      .map((l) => JSON.parse(l.slice(5).trim()) as StreamEvent);
  }

  async function send(branchId: string, json: Record<string, unknown>) {
    const res = await call(`/api/branches/${branchId}/messages`, { json });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    return events(text);
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
  it('reports the window, the server cap and the list price', async () => {
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

    // `simple` is priced at 1 µ$ a token each way (vitest.config.ts MODEL_PRICES).
    const credit = await trunk({ providerId: 'openrouter', funding: 'credit', model: 'simple' });
    const body = (await (
      await call(`/api/branches/${credit}/input-budget`)
    ).json()) as InputBudgetResponse;
    expect(body).toMatchObject({
      model: 'simple',
      funding: 'credit',
      serverMaxInputTokens: CREDIT_CAP,
      price: { inputUsdPerMTok: 1, cacheReadUsdPerMTok: null },
    });
  });
});
