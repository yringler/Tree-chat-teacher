import { describe, expect, it } from 'vitest';
import { updateSettingsRequestSchema } from './api.js';
import {
  DEFAULT_LEARN_REPLY,
  LEARN_REPLY_POOL_NOTE,
  learnReplyIndicator,
  replyLengthInstructions,
  type LearnReplyContext,
} from './learn-reply.js';
import { WORDS_PER_PAGE } from './token-size.js';

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

describe('replyLengthInstructions', () => {
  it('sends nothing for Normal, and word targets of a few pages and a chapter', () => {
    expect(replyLengthInstructions('normal')).toBeNull();
    expect(replyLengthInstructions('long')).toContain('1,000 words');
    expect(replyLengthInstructions('veryLong')).toContain('3,000 words');
    // About 4 and 11 pages: longer than Normal's page.
    expect(1000 / WORDS_PER_PAGE).toBeGreaterThan(3);
    for (const length of ['long', 'veryLong'] as const) {
      const text = replyLengthInstructions(length) ?? '';
      expect(text).toContain('`##`');
      expect(text).toMatch(/tangents block still comes last/);
    }
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
