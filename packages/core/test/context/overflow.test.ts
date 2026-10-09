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

  it('compact whose summary failed falls back to truncate, and records it', () => {
    const f = new Fixture();
    const Y = 'y'.repeat(1100); // 1104 tokens per message with charTokens
    for (let i = 0; i < 10; i++) f.add('T', i % 2 === 0 ? 'user' : 'assistant', Y);
    const options = { estimateTokens: charTokens, budget: { maxInputTokens: 5000 } };
    const key = f.plan('T', options).compaction!.key;
    const plan = f.plan('T', { ...options, failedSummaries: new Set([summaryKeyString(key)]) });
    const truncated = f.plan('T', {
      estimateTokens: charTokens,
      budget: { maxInputTokens: 5000, ...overflowBudget('truncate') },
    });
    expect(plan.segments).toEqual(truncated.segments);
    expect(plan.compaction).toBeNull();
    // Four messages fit; compacting would have kept two (the step's worth went into the summary).
    expect(plan.truncation).toEqual({
      droppedSegmentIds: ['seg-4', 'seg-5', 'seg-6', 'seg-7', 'seg-8', 'seg-9'],
      droppedNodeIds: ids(6),
      tokensBefore: 11040,
      tokensAfter: 4416,
      compactionFailed: true,
    });
    expect(truncated.truncation!.compactionFailed).toBe(false);
    expect(plan.budget.usedTokens).toBe(4416);
    expect(plan.pendingSummaries).toEqual([]);
  });

  it('compact blocked by a failed branch summary falls back to truncate too', () => {
    const f = new Fixture();
    f.messages('T', 2);
    const b = f.fork('T.1', 'summary');
    const Y = 'y'.repeat(1100);
    for (let i = 0; i < 10; i++) f.add(b, i % 2 === 0 ? 'user' : 'assistant', Y);
    const options = { estimateTokens: charTokens, budget: { maxInputTokens: 5000 } };
    const branchKey = f.plan(b).pendingSummaries[0]!.key;
    const plan = f.plan(b, { ...options, failedSummaries: new Set([summaryKeyString(branchKey)]) });
    // The compaction would hold the failed summary, so it could never be made:
    // no 0-token summary stands in for the oldest messages.
    expect(plan.compaction).toBeNull();
    expect(plan.segments.filter((s) => s.kind === 'summary')).toEqual([]);
    expect(plan.pendingSummaries).toEqual([]);
    expect(plan.truncation).toMatchObject({ tokensAfter: 4416, compactionFailed: true });
    expect(plan.budget.usedTokens).toBe(4416);
  });
});
