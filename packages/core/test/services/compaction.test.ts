import { describe, expect, it } from 'vitest';
import { send, setup } from './helpers.js';

/** About 400 estimated tokens: a long question, so a dozen turns pass the input cap. */
const question = (i: number) => `q${i} ${'x'.repeat(1390)}`;

describe('ChatService compaction over many turns', () => {
  it('reuses one cached summary and keeps the sent prefix until the context grows a step', async () => {
    const s = setup({ autoTitle: false, maxInputTokens: 6000 });
    const { tree } = await s.chat.createTree({ systemPrompt: 'Be a kind tutor.' });
    const summariesAfter: number[] = [];
    for (let i = 0; i < 30; i++) {
      await send(s.chat, tree.trunkBranchId, question(i));
      summariesAfter.push(s.provider.summaryCalls().length);
    }
    const calls = s.provider.chatCalls();
    expect(calls).toHaveLength(30);

    // The turns that compacted: one summary call each, and none in between.
    const compacting = summariesAfter.flatMap((n, i) =>
      n > (i === 0 ? 0 : summariesAfter[i - 1]!) ? [i] : [],
    );
    // The cap is passed at the 15th turn; a step is half the 6,000-token
    // budget, 7 of these turns. (Compacting only what each turn needs made a
    // summary call on every one of the last 16 turns.)
    expect(compacting).toEqual([14, 21, 28]);
    for (const i of compacting) expect(summariesAfter[i]! - (summariesAfter[i - 1] ?? 0)).toBe(1);
    const plan = await s.chat.planContext(tree.trunkBranchId, null, { resolveSummaries: false });
    expect(plan.plan.complete).toBe(true);
    expect(plan.plan.truncation).toBeNull();
    // Each summary is cached once; the turns in between found it there.
    expect(s.repos.dump().summaries.size).toBe(s.provider.summaryCalls().length);
    const transcripts = s.provider.summaryCalls().map((c) => c.messages[0]!.content);
    expect(new Set(transcripts).size).toBe(transcripts.length);

    // Between compactions every turn sends the same system prompt (with the
    // summary) and starts its messages with the previous turn's: the prompt
    // prefix the provider cached on one turn is the start of the next.
    const first = compacting[0]!;
    for (let i = first + 1; i < calls.length; i++) {
      if (compacting.includes(i)) continue;
      const before = calls[i - 1]!;
      const now = calls[i]!;
      expect(now.system).toBe(before.system);
      expect(now.system).toContain('SUMMARY(');
      expect(now.messages.slice(0, before.messages.length)).toEqual(before.messages);
    }
  });
});
