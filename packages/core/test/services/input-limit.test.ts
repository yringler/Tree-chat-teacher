import type { GenerateRequest } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import type { ChatSettings, RunGenerationOptions } from '../../src/services/chat-service.js';
import { send, setup } from './helpers.js';

/** Power's input limit and over-limit choice (`RunGenerationOptions.maxInputTokens`, `.inputOverflow`). */
describe('input limit', () => {
  /** ~2,900 tokens at 3.5 chars a token: three of them overflow a 6,000-token limit. */
  const LONG = 'x'.repeat(10_000);

  async function conversation(settings: Partial<ChatSettings> = {}) {
    const s = setup(settings);
    s.provider.contextTokens = 200_000;
    s.provider.maxOutputTokens = 4096;
    const detail = await s.chat.createTree({ providerId: 'scripted' });
    const branchId = detail.tree.trunkBranchId;
    for (const n of [1, 2, 3]) await send(s.chat, branchId, `${n} ${LONG}`);
    return { ...s, branchId };
  }

  const chars = (c: GenerateRequest | undefined) =>
    c!.messages.reduce((n, m) => n + m.content.length, 0);
  /** Whether the request carries a compaction summary (wherever the renderer puts it). */
  const summarized = (c: GenerateRequest | undefined) =>
    [c!.system ?? '', ...c!.messages.map((m) => m.content)].some((t) => t.includes('SUMMARY('));

  async function last(options: RunGenerationOptions, settings: Partial<ChatSettings> = {}) {
    const s = await conversation(settings);
    s.provider.calls.length = 0;
    await send(s.chat, s.branchId, 'And now?', options);
    return {
      chat: s.provider.chatCalls().at(-1),
      summaries: s.provider.calls.filter((c) => s.provider.kindOf(c) === 'summary'),
    };
  }

  it('sends the whole path without a limit', async () => {
    const { chat, summaries } = await last({});
    expect(chars(chat)).toBeGreaterThan(30_000);
    expect(summaries).toEqual([]);
  });

  it('compacts the oldest messages to fit the limit by default', async () => {
    const { chat, summaries } = await last({ maxInputTokens: 6000 });
    expect(summaries).toHaveLength(1);
    expect(chars(chat)).toBeLessThan(6000 * 3.5);
    expect(summarized(chat)).toBe(true);
    // The newest message is kept as it is.
    expect(chat!.messages.at(-1)!.content).toBe('And now?');
  });

  it('drops the oldest messages instead, with no summary, for truncate', async () => {
    const { chat, summaries } = await last({ maxInputTokens: 6000, inputOverflow: 'truncate' });
    expect(summaries).toEqual([]);
    expect(chars(chat)).toBeLessThan(6000 * 3.5);
    expect(summarized(chat)).toBe(false);
    expect(chat!.messages.some((m) => m.content.startsWith('1 '))).toBe(false);
    expect(chat!.messages.at(-1)!.content).toBe('And now?');
  });

  it('never raises the budget above the window less the reply, nor the settings’ cap', async () => {
    const above = await last({ maxInputTokens: 2_000_000 });
    expect(chars(above.chat)).toBeGreaterThan(30_000);
    const capped = await last({ maxInputTokens: 2_000_000 }, { maxInputTokens: 6000 });
    expect(summarized(capped.chat)).toBe(true);
    expect(chars(capped.chat)).toBeLessThan(6000 * 3.5);
  });

  it('plans the Context preview with the same limits', async () => {
    const s = await conversation();
    const plain = await s.chat.planContext(s.branchId, null, { resolveSummaries: false });
    expect(plain.plan.budget.maxInputTokens).toBe(200_000 - 4096);
    expect(plain.plan.compaction).toBeNull();

    const limited = await s.chat.planContext(s.branchId, null, {
      resolveSummaries: false,
      limits: { maxInputTokens: 6000 },
    });
    expect(limited.plan.budget.maxInputTokens).toBe(6000);
    expect(limited.plan.compaction).not.toBeNull();

    const dropped = await s.chat.planContext(s.branchId, null, {
      resolveSummaries: false,
      limits: { maxInputTokens: 6000, inputOverflow: 'truncate' },
    });
    expect(dropped.plan.compaction).toBeNull();
    expect(dropped.plan.truncation).not.toBeNull();

    // The reply length reserves its room out of the window here too.
    const roomy = await s.chat.planContext(s.branchId, null, {
      resolveSummaries: false,
      limits: { maxOutputTokens: 1000 },
    });
    expect(roomy.plan.budget.maxInputTokens).toBe(200_000 - 1000);
  });

  it('reports what bounds the input on the branch', async () => {
    const s = await conversation({ maxInputTokens: 50_000 });
    s.provider.reasoning = true;
    expect(await s.chat.inputBudget(s.branchId)).toEqual({
      model: 'm1',
      funding: 'own-key',
      contextTokens: 200_000,
      maxOutputTokens: 4096,
      reasoning: true,
      maxInputTokens: 50_000,
    });
  });
});
