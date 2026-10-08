import type { ChatSettings } from '../../src/services/chat-service.js';
import { describe, expect, it } from 'vitest';
import { send, setup } from './helpers.js';

/** Output caps (`@tangent/shared` output-tokens.ts): larger for reasoning models, power's own setting. */
describe('reply output caps', () => {
  async function capsOf(
    opts: { reasoning: boolean; limit: number; requested?: number },
    settings: Partial<ChatSettings> = {},
  ) {
    const s = setup(settings);
    s.provider.reasoning = opts.reasoning;
    s.provider.maxOutputTokens = opts.limit;
    const detail = await s.chat.createTree({ providerId: 'scripted' });
    await send(
      s.chat,
      detail.tree.trunkBranchId,
      'Derive it',
      opts.requested !== undefined ? { maxOutputTokens: opts.requested } : {},
    );
    const chat = s.provider.chatCalls().map((c) => c.maxOutputTokens);
    const titles = s.provider.calls
      .filter((c) => s.provider.kindOf(c) === 'title')
      .map((c) => c.maxOutputTokens);
    return { chat, titles };
  }

  it('gives a plain model 4,096 and a reasoning model 16,384, within the model limit', async () => {
    expect((await capsOf({ reasoning: false, limit: 40_000 })).chat).toEqual([4096]);
    expect((await capsOf({ reasoning: true, limit: 40_000 })).chat).toEqual([16_384]);
    expect((await capsOf({ reasoning: true, limit: 8192 })).chat).toEqual([8192]);
    expect((await capsOf({ reasoning: false, limit: 1000 })).chat).toEqual([1000]);
  });

  it('follows the settings’ defaults (Learn, the pool)', async () => {
    const settings = { reservedOutputTokens: 2048, reasoningOutputTokens: 3000 };
    expect((await capsOf({ reasoning: false, limit: 40_000 }, settings)).chat).toEqual([2048]);
    expect((await capsOf({ reasoning: true, limit: 40_000 }, settings)).chat).toEqual([3000]);
  });

  it('uses the requested cap instead, still within the model limit', async () => {
    const plain = await capsOf({ reasoning: false, limit: 40_000, requested: 8000 });
    expect(plain.chat).toEqual([8000]);
    const lower = await capsOf({ reasoning: true, limit: 40_000, requested: 2000 });
    expect(lower.chat).toEqual([2000]);
    const above = await capsOf({ reasoning: true, limit: 32_000, requested: 100_000 });
    expect(above.chat).toEqual([32_000]);
  });

  it('gives titles 1,024 tokens, or 4,096 on a reasoning model', async () => {
    expect((await capsOf({ reasoning: false, limit: 40_000 })).titles).toEqual([1024]);
    expect((await capsOf({ reasoning: true, limit: 40_000 })).titles).toEqual([4096]);
    // Never below the old 1,024, even under a lower model limit (the pool's meter caps it).
    expect((await capsOf({ reasoning: true, limit: 512 })).titles).toEqual([1024]);
  });

  it('reserves the requested cap out of the context window', async () => {
    const s = setup();
    s.provider.maxOutputTokens = 100_000;
    s.provider.contextTokens = 120_000;
    const detail = await s.chat.createTree({ providerId: 'scripted' });
    const branchId = detail.tree.trunkBranchId;
    // A long first message (~57k tokens at 3.5 chars a token): it fits next to 4,096 out,
    // not next to 90,000 out.
    await send(s.chat, branchId, 'x'.repeat(200_000));
    await send(s.chat, branchId, 'Short');
    await send(s.chat, branchId, 'Again', { maxOutputTokens: 90_000 });
    const [, roomy, tight] = s.provider.chatCalls();
    const chars = (c: typeof roomy) => c!.messages.reduce((n, m) => n + m.content.length, 0);
    expect(chars(roomy)).toBeGreaterThan(200_000);
    expect(chars(tight)).toBeLessThan(200_000);
    expect(tight!.maxOutputTokens).toBe(90_000);
  });
});
