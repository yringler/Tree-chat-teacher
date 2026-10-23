import { describe, expect, it } from 'vitest';
import { updateSettingsRequestSchema } from './api.js';
import {
  DEFAULT_LEARN_REPLY,
  effectiveLearnTier,
  LEARN_REPLY_LENGTHS,
  LENGTH_REQUIRES_MAX,
  LEARN_REPLY_POOL_NOTE,
  learnReplyIndicator,
  REPLY_LENGTH_WORDS,
  replyLengthInstructions,
  type LearnReplyContext,
} from './learn-reply.js';
import { BUILT_IN_MAX_OUTPUT_TOKENS } from './output-tokens.js';

const paid: LearnReplyContext = { pool: false, fixedModel: false };

describe('learnReplyIndicator', () => {
  it('shows nothing while every setting is the default', () => {
    expect(learnReplyIndicator(DEFAULT_LEARN_REPLY, paid)).toBeNull();
    expect(learnReplyIndicator(DEFAULT_LEARN_REPLY, { pool: true, fixedModel: false })).toBeNull();
  });

  it('names only the settings that differ from the default', () => {
    expect(learnReplyIndicator({ tier: 'max', replyLength: 'normal' }, paid)).toEqual({
      label: 'Max',
      off: false,
      note: null,
      ariaLabel: 'Advanced settings: Max model. Change',
    });
    expect(learnReplyIndicator({ tier: 'normal', replyLength: 'long' }, paid)?.label).toBe('Long');
    expect(learnReplyIndicator({ tier: 'max', replyLength: 'veryLong' }, paid)).toEqual({
      label: 'Max · Very long',
      off: false,
      note: null,
      ariaLabel: 'Advanced settings: Max model, very long replies. Change',
    });
  });

  it('is muted, with a note, while the open pool pays', () => {
    expect(
      learnReplyIndicator({ tier: 'max', replyLength: 'long' }, { pool: true, fixedModel: false }),
    ).toEqual({
      label: 'Max · Long',
      off: true,
      note: LEARN_REPLY_POOL_NOTE,
      ariaLabel: 'Advanced settings: Max model, long replies, not used for free replies. Change',
    });
  });

  it('leaves out Max on a key with one model, where it changes nothing', () => {
    const fixed = { pool: false, fixedModel: true };
    expect(learnReplyIndicator({ tier: 'max', replyLength: 'normal' }, fixed)).toBeNull();
    expect(learnReplyIndicator({ tier: 'max', replyLength: 'veryLong' }, fixed)?.label).toBe(
      'Very long',
    );
  });
});

describe('effectiveLearnTier', () => {
  it('runs Very long on Max whatever tier is saved, and the other lengths on the saved tier', () => {
    expect(LENGTH_REQUIRES_MAX).toEqual({ normal: false, long: false, veryLong: true });
    expect(effectiveLearnTier({ tier: 'normal', replyLength: 'veryLong' })).toBe('max');
    expect(effectiveLearnTier({ tier: 'max', replyLength: 'veryLong' })).toBe('max');
    for (const replyLength of ['normal', 'long'] as const) {
      expect(effectiveLearnTier({ tier: 'normal', replyLength })).toBe('normal');
      expect(effectiveLearnTier({ tier: 'max', replyLength })).toBe('max');
    }
  });
});

describe('REPLY_LENGTH_WORDS', () => {
  it('gives every length a range around its target, each longer than the one before', () => {
    let previousMax = 0;
    for (const length of LEARN_REPLY_LENGTHS) {
      const { min, target, max } = REPLY_LENGTH_WORDS[length];
      expect(min).toBeGreaterThanOrEqual(0);
      expect(min).toBeLessThan(target);
      expect(target).toBeLessThan(max);
      expect(max).toBeGreaterThan(previousMax);
      previousMax = max;
    }
  });

  it('keeps the longest inside a reasoning reply cap, about 4/3 tokens a word', () => {
    expect((REPLY_LENGTH_WORDS.veryLong.max * 4) / 3).toBeLessThan(BUILT_IN_MAX_OUTPUT_TOKENS / 2);
  });
});

describe('replyLengthInstructions', () => {
  const number = (n: number) => n.toLocaleString('en-US');

  it('names each length its range and target, from the table', () => {
    for (const length of LEARN_REPLY_LENGTHS) {
      const { min, target, max } = REPLY_LENGTH_WORDS[length];
      const text = replyLengthInstructions(length);
      expect(text).toContain(number(target));
      expect(text).toContain(number(max));
      if (min > 0) expect(text).toContain(number(min));
    }
  });

  it('treats the range as leeway: no padding, nothing needed cut short', () => {
    for (const length of LEARN_REPLY_LENGTHS) {
      const text = replyLengthInstructions(length);
      expect(text).toMatch(/not a quota/);
      expect(text).toMatch(/Don't pad/);
      expect(text).toMatch(/don't cut a needed explanation short/);
      expect(text).toMatch(/tangents block still comes last/);
    }
  });

  it('sections the longer lengths under `##` headings only past a threshold, not Normal', () => {
    expect(replyLengthInstructions('normal')).not.toContain('`##`');
    for (const length of ['long', 'veryLong'] as const) {
      const text = replyLengthInstructions(length);
      expect(text).toContain('`##`');
      expect(text).toMatch(/Past about 600 words/);
      expect(text).toMatch(/no title or heading/);
    }
  });

  it('gives Long and Very long the same rules against padding and slips', () => {
    const rules = (length: 'long' | 'veryLong') =>
      replyLengthInstructions(length)
        .split('\n')
        .filter((line) => line.startsWith('- '));
    expect(rules('long').length).toBeGreaterThan(0);
    expect(rules('veryLong')).toEqual(rules('long'));
    const text = replyLengthInstructions('long');
    expect(text).toMatch(/only on new material/);
    expect(text).toMatch(/check every number/);
    expect(text).toMatch(/Make each point once/);
    expect(text).toMatch(/Don't list the sections/);
    expect(text).toMatch(/no summary, recap/);
    expect(text).toMatch(/no misconceptions section/);
    expect(text).toMatch(/only those you're sure of/);
    expect(text).toMatch(/attribute a contested claim/);
    expect(text).toMatch(/without redefining them/);
    expect(text).toMatch(/at most 6 suggestions/);
    expect(replyLengthInstructions('normal')).not.toMatch(/^- /m);
  });
});

describe('updateSettingsRequestSchema learn', () => {
  it('takes either setting, and refuses an empty or unknown one', () => {
    expect(updateSettingsRequestSchema.safeParse({ learn: { tier: 'max' } }).success).toBe(true);
    expect(
      updateSettingsRequestSchema.safeParse({ learn: { replyLength: 'veryLong' } }).success,
    ).toBe(true);
    expect(updateSettingsRequestSchema.safeParse({ learn: {} }).success).toBe(false);
    expect(updateSettingsRequestSchema.safeParse({ learn: { replyLength: 'huge' } }).success).toBe(
      false,
    );
  });
});
