import { describe as suite, expect, it } from 'vitest';
import { summaryKeyString } from '../../src/context/assemble.js';
import { overflowBudget } from '../../src/context/overflow.js';
import { charTokens, describe, Fixture } from './fixtures.js';

const X = 'x'.repeat(100); // 104 tokens per message with charTokens

/** Trunk with `count` 100-char messages, ids T.0 … */
function long(count: number): Fixture {
  const f = new Fixture();
  for (let i = 0; i < count; i++) f.add('T', i % 2 === 0 ? 'user' : 'assistant', X);
  return f;
}

/** `T.0` … `T.<count-1>`. */
const ids = (count: number) => Array.from({ length: count }, (_, i) => `T.${i}`);

const budget = { maxInputTokens: 500, compactionSummaryTokens: 100, minTailMessages: 2 };

suite('overflowBudget', () => {
  it('leaves the budget alone for compact (and by default)', () => {
    expect(overflowBudget('compact')).toEqual({});
    expect(overflowBudget(undefined)).toEqual({});
  });

  it('compact: the oldest messages become a summary', () => {
    const plan = long(10).plan('T', {
      estimateTokens: charTokens,
      budget: { ...budget, ...overflowBudget('compact') },
    });
    expect(describe(plan)[0]).toBe('sum:compaction:pending');
    expect(plan.compaction).not.toBeNull();
    expect(plan.truncation).toBeNull();
    expect(plan.pendingSummaries).toHaveLength(1);
  });

  it('truncate: the oldest messages are dropped, with no summary to make', () => {
    const plan = long(10).plan('T', {
      estimateTokens: charTokens,
      budget: { ...budget, ...overflowBudget('truncate') },
    });
    expect(plan.compaction).toBeNull();
    expect(plan.pendingSummaries).toEqual([]);
    expect(plan.complete).toBe(true);
    // The oldest go first (how many is the budget pass's business), the newest stay.
    const kept = plan.segments.map((s) => s.sourceNodeIds[0]!);
    const dropped = plan.truncation!.droppedNodeIds;
    expect(dropped.length).toBeGreaterThan(0);
    expect([...dropped, ...kept]).toEqual(ids(10));
    expect(plan.truncation!.tokensBefore).toBe(1040);
    expect(plan.budget.usedTokens).toBeLessThanOrEqual(500);
  });

  it('truncate keeps the target message even when it alone is over the budget', () => {
    const f = new Fixture();
    f.add('T', 'user', X);
    f.add('T', 'assistant', X);
    f.add('T', 'user', 'y'.repeat(600));
    const plan = f.plan('T', {
      estimateTokens: charTokens,
      budget: { maxInputTokens: 300, minTailMessages: 0, ...overflowBudget('truncate') },
    });
    expect(plan.segments.map((s) => s.sourceNodeIds[0])).toEqual(['T.2']);
    expect(plan.compaction).toBeNull();
  });

  it('compact whose summary failed leaves the oldest messages out, like truncate', () => {
    const f = long(10);
    const input = f.input('T', { estimateTokens: charTokens, budget });
    const key = f.plan('T', { estimateTokens: charTokens, budget }).compaction!.key;
    const plan = f.plan('T', {
      ...input,
      failedSummaries: new Set([summaryKeyString(key)]),
    });
    expect(describe(plan)[0]).toBe('sum:compaction:failed');
    const kept = plan.segments.filter((s) => s.kind !== 'summary').map((s) => s.sourceNodeIds[0]!);
    expect(kept.at(-1)).toBe('T.9');
    expect([...plan.compaction!.compactedNodeIds, ...kept]).toEqual(ids(10));
    expect(plan.budget.usedTokens).toBeLessThanOrEqual(500);
  });
});
