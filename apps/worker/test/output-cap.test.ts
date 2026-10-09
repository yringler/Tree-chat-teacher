import type { StreamEvent, TreeDetail } from '@tangent/shared';
import { env as rawEnv, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { grantCredit } from '../src/billing/ledger.js';
import { USAGE_HOLD_MICROS } from '../src/billing/service.js';
import type { AppEnv } from '../src/env.js';
import { resolvePoolParams } from '../src/pool/params.js';
import {
  builtInPowerConfig,
  poolChatSettings,
  simpleChatSettings,
  simpleMaxInputTokens,
} from '../src/simple-mode.js';
import { poolReadyUser } from './pool-helpers.js';

/**
 * A reply's output cap (`SendMessageRequest.maxOutputTokens`): power sends
 * its setting, capped at the model's limit; Learn and the pool ignore it.
 * The fake providers echo the request's cap on `[echo-request]` (vitest.config.ts).
 */
const env = rawEnv as unknown as AppEnv;
const BASE = 'https://tangent.example.com';
const ECHO = '[echo-request]';

function call(path: string, json: unknown): Promise<Response> {
  return exports.default.fetch(
    new Request(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
    }),
  );
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

/** The output cap the echoing fake was sent. */
function echoedCap(text: string): string {
  const m = /^ECHO model=\S+ maxOutputTokens=(\S+) /.exec(replyOf(text));
  expect(m, text).not.toBeNull();
  return m![1]!;
}

describe('power: the reply length setting', () => {
  async function trunk(): Promise<string> {
    const res = await call('/api/trees', { title: 'Cap', providerId: 'fake' });
    expect(res.status).toBe(201);
    return ((await res.json()) as TreeDetail).tree.trunkBranchId;
  }

  it('sends the default without a setting, the setting within the model limit, and clamps above it', async () => {
    const branchId = await trunk();
    const send = async (extra: Record<string, unknown>) => {
      const res = await call(`/api/branches/${branchId}/messages`, { content: ECHO, ...extra });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      return echoedCap(text);
    };
    // fake-1 doesn't reason: the default 4,096, which is also the fake provider's limit.
    expect(await send({})).toBe('4096');
    expect(await send({ maxOutputTokens: 1000 })).toBe('1000');
    expect(await send({ maxOutputTokens: 32_768 })).toBe('4096');
  });

  it('rejects a cap outside the accepted range', async () => {
    const branchId = await trunk();
    for (const maxOutputTokens of [100, 200_000, 1.5, '4096']) {
      const res = await call(`/api/branches/${branchId}/messages`, {
        content: 'Hi',
        maxOutputTokens,
      });
      expect(res.status, String(maxOutputTokens)).toBe(400);
      await res.text();
    }
  });
});

describe('Learn ignores a requested cap', () => {
  it('keeps its own cap on personal credit and the pool’s on the pool', async () => {
    const u = await poolReadyUser();
    const created = await u.client.call('/api/trees', {
      method: 'POST',
      json: { title: 'L', model: 'max' },
      learn: 'credit',
    });
    expect(created.status).toBe(201);
    const branchId = ((await created.json()) as TreeDetail).tree.trunkBranchId;
    await grantCredit(env.DB, {
      accountId: `u_${u.userId}`,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
    });
    for (const [learn, cap] of [
      ['credit', '4096'],
      ['pool', '2048'],
    ] as const) {
      const res = await u.client.call(`/api/branches/${branchId}/messages`, {
        method: 'POST',
        json: { content: `Q ${ECHO}`, maxOutputTokens: 1000 },
        learn,
      });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      expect(echoedCap(text), learn).toBe(cap);
    }
  });
});

describe('the built-in provider’s bounds', () => {
  it('lets a reasoning model use 16,384 output tokens in Learn and on credit; the pool keeps its cap', async () => {
    const credit = builtInPowerConfig(env);
    expect(credit.maxOutputTokens).toBe(16_384);
    expect(credit.maxContextTokens).toBe(simpleMaxInputTokens(env) + 16_384);
    expect(simpleChatSettings(env)).toMatchObject({
      reservedOutputTokens: 4096,
      reasoningOutputTokens: 16_384,
      maxInputTokens: simpleMaxInputTokens(env),
    });
    const pool = await resolvePoolParams(env, null);
    expect(poolChatSettings(pool)).toMatchObject({
      reservedOutputTokens: pool.maxOutputTokens,
      reasoningOutputTokens: pool.maxOutputTokens,
    });
  });

  it('keeps the personal-credit hold flat: a minimum balance, not the cap’s worst case', () => {
    // 16,384 tokens at $10/MTok would be a $0.16 hold; the hold stays USAGE_HOLD_MICROS and the
    // charge is the reported cost (billing-meter.test.ts), so a larger cap can't undercharge.
    expect(USAGE_HOLD_MICROS).toBe(20_000);
  });
});
