import { describe, expect, it } from 'vitest';
import { updateSettingsRequestSchema } from './api.js';
import {
  DEFAULT_LEARN_REPLY,
  effectiveLearnTier,
  LEARN_REPLY_LENGTHS,
  LENGTH_REQUIRES_MAX,
  LEARN_REPLY_LONG_WARNING,
  LEARN_REPLY_POOL_NOTE,
  LEARN_REPLY_WARNING_MARK,
  learnReplyIndicator,
  REPLY_LENGTH_HINTS,
  warnsLongOnNormal,
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
    expect(learnReplyIndicator({ tier: 'max', replyLength: 'long' }, paid)).toEqual({
      label: 'Max · Long',
      off: false,
      note: null,
      ariaLabel: 'Advanced settings: Max model, long replies. Change',
    });
  });

  it('shows Very long on Max, the model it needs, whatever tier is saved', () => {
    const veryLong = {
      label: 'Very long · Max',
      off: false,
      note: null,
      ariaLabel:
        'Advanced settings: very long replies, Max model (required for very long replies). Change',
    };
    expect(learnReplyIndicator({ tier: 'max', replyLength: 'veryLong' }, paid)).toEqual(veryLong);
    expect(learnReplyIndicator({ tier: 'normal', replyLength: 'veryLong' }, paid)).toEqual(
      veryLong,
    );
  });

  it('warns of Long on Normal, and says why to a screen reader', () => {
    expect(learnReplyIndicator({ tier: 'normal', replyLength: 'long' }, paid)).toEqual({
      label: '⚠️ Long',
      off: false,
      note: null,
      ariaLabel: `Advanced settings: long replies. ${LEARN_REPLY_LONG_WARNING} Change`,
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
    // No warning where the length isn't used.
    expect(
      learnReplyIndicator(
        { tier: 'normal', replyLength: 'long' },
        { pool: true, fixedModel: false },
      ),
    ).toMatchObject({ label: 'Long', off: true });
  });

  it('leaves out Max on a key with one model, where it changes nothing', () => {
    const fixed = { pool: false, fixedModel: true };
    expect(learnReplyIndicator({ tier: 'max', replyLength: 'normal' }, fixed)).toBeNull();
    expect(learnReplyIndicator({ tier: 'normal', replyLength: 'veryLong' }, fixed)).toEqual({
      label: 'Very long',
      off: false,
      note: null,
      ariaLabel: 'Advanced settings: very long replies. Change',
    });
    // Its one model is the stronger one: no warning for Long.
    expect(learnReplyIndicator({ tier: 'normal', replyLength: 'long' }, fixed)?.label).toBe('Long');
  });
});

describe('warnsLongOnNormal', () => {
  it('warns only of Long on Normal, where the model can be chosen and the length applies', () => {
    expect(warnsLongOnNormal({ tier: 'normal', replyLength: 'long' }, paid)).toBe(true);
    expect(warnsLongOnNormal({ tier: 'max', replyLength: 'long' }, paid)).toBe(false);
    expect(warnsLongOnNormal({ tier: 'normal', replyLength: 'normal' }, paid)).toBe(false);
    expect(warnsLongOnNormal({ tier: 'normal', replyLength: 'veryLong' }, paid)).toBe(false);
    expect(
      warnsLongOnNormal({ tier: 'normal', replyLength: 'long' }, { pool: false, fixedModel: true }),
    ).toBe(false);
    expect(
      warnsLongOnNormal({ tier: 'normal', replyLength: 'long' }, { pool: true, fixedModel: false }),
    ).toBe(false);
  });

  it('says what Very long costs, and what Long risks on Normal', () => {
    expect(REPLY_LENGTH_HINTS.veryLong).toMatch(/Uses the Max model .*20× the cost of Normal/);
    expect(`${LEARN_REPLY_WARNING_MARK} ${LEARN_REPLY_LONG_WARNING}`).toBe(
      '⚠️ On the Normal model, long replies are more likely to have accuracy issues. Consider switching to Max.',
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
    }
    expect(replyLengthInstructions('normal')).toMatch(/tangents block still comes last/);
  });

  it('keeps headings off a reply under about 600 words, and off Normal', () => {
    expect(replyLengthInstructions('normal')).not.toContain('`##`');
    for (const length of ['long', 'veryLong'] as const) {
      const text = replyLengthInstructions(length);
      expect(text).toContain('`##`');
      expect(text).toMatch(/A reply under about 600 words has no headings\./);
      expect(text).toMatch(/no title or heading/);
    }
  });

  const rules = (length: 'long' | 'veryLong') =>
    replyLengthInstructions(length)
      .split('\n')
      .filter((line) => line.startsWith('- '));

  it('gives Long and Very long the same rules against padding and slips, but one', () => {
    const long = rules('long');
    const veryLong = rules('veryLong');
    expect(long.length).toBeGreaterThan(1);
    expect(veryLong.length).toBe(long.length);
    expect(veryLong.filter((line) => !long.includes(line))).toHaveLength(1);
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

  it('turns the closing diagram offer into a tangent, and always ends on the tangents block', () => {
    for (const length of ['long', 'veryLong'] as const) {
      const text = replyLengthInstructions(length);
      expect(text).toMatch(/Leave out the closing offer to draw a diagram/);
      expect(text).toMatch(/make it one of the tangents instead/);
      expect(text).toMatch(/Always end with the tangents block/);
    }
    expect(replyLengthInstructions('normal')).not.toMatch(/diagram/);
  });

  it('lets only Long stop early on a narrow question, and pushes Very long toward a chapter', () => {
    const narrowStop = /If the question is narrow, stop when it's answered/;
    const chapter = /wants a chapter/;
    expect(replyLengthInstructions('long')).toMatch(narrowStop);
    expect(replyLengthInstructions('long')).not.toMatch(chapter);
    const veryLong = replyLengthInstructions('veryLong');
    expect(veryLong).not.toMatch(narrowStop);
    expect(veryLong).toMatch(chapter);
    expect(veryLong).toMatch(/what a textbook chapter on this would cover/);
    expect(veryLong).toMatch(/a second worked example of a different kind/);
    expect(veryLong).toMatch(/only when the question is truly narrow/);
    expect(veryLong).toMatch(/clearly beyond what a Long reply would cover/);
    expect(replyLengthInstructions('normal')).not.toMatch(narrowStop);
    expect(replyLengthInstructions('normal')).not.toMatch(chapter);
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
