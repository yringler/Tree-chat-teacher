import { describe, expect, it } from 'vitest';
import {
  errorKindOf,
  isCutOffReply,
  isLengthStop,
  isStoppedReply,
  REPLY_CANCELLED_ERROR,
  REPLY_CUT_OFF_ERROR,
  REPLY_EMPTY_ERROR,
  REPLY_INTERRUPTED_ERROR,
  REPLY_STREAM_ENDED_ERROR,
  REPLY_THINKING_ONLY_ERROR,
} from './stop-reason.js';

describe('isLengthStop', () => {
  it('is true for the output cap (OpenAI/OpenRouter `length`, Anthropic `max_tokens`) only', () => {
    expect(isLengthStop('length')).toBe(true);
    expect(isLengthStop('max_tokens')).toBe(true);
    for (const other of ['stop', 'end_turn', 'tool_calls', 'content_filter', '', null, undefined])
      expect(isLengthStop(other)).toBe(false);
  });
});

describe('errorKindOf', () => {
  it('is the stored kind, whatever the copy says', () => {
    expect(
      errorKindOf({ status: 'error', errorKind: 'provider', error: REPLY_CUT_OFF_ERROR }),
    ).toBe('provider');
  });

  it('reads the kind of a node without one from its fixed message', () => {
    const copies = [
      [REPLY_CUT_OFF_ERROR, 'cut_off'],
      [REPLY_THINKING_ONLY_ERROR, 'thinking_only'],
      [REPLY_EMPTY_ERROR, 'empty'],
      [REPLY_CANCELLED_ERROR, 'cancelled'],
      [REPLY_INTERRUPTED_ERROR, 'interrupted'],
      [REPLY_STREAM_ENDED_ERROR, 'provider'],
    ] as const;
    for (const [error, kind] of copies) {
      expect(errorKindOf({ status: 'error', error })).toBe(kind);
      expect(errorKindOf({ status: 'error', errorKind: null, error })).toBe(kind);
    }
  });

  it('is null for a node that is not an error, or whose message is no fixed one', () => {
    expect(errorKindOf({ status: 'complete', error: REPLY_CUT_OFF_ERROR })).toBeNull();
    expect(errorKindOf({ status: 'complete', errorKind: 'cut_off' })).toBeNull();
    expect(errorKindOf({ status: 'error', error: 'HTTP 500' })).toBeNull();
    expect(errorKindOf({ status: 'error', error: null })).toBeNull();
  });
});

describe('isCutOffReply', () => {
  it('is an error node of kind cut_off, never another failure', () => {
    expect(isCutOffReply({ status: 'error', errorKind: 'cut_off' })).toBe(true);
    for (const errorKind of ['thinking_only', 'empty', 'cancelled', 'provider', null] as const)
      expect(isCutOffReply({ status: 'error', errorKind })).toBe(false);
    expect(isCutOffReply({ status: 'complete', errorKind: 'cut_off' })).toBe(false);
  });

  it('is a node stored without a kind that has the cut-off message (an old backup or row)', () => {
    expect(isCutOffReply({ status: 'error', error: REPLY_CUT_OFF_ERROR })).toBe(true);
  });
});

describe('isStoppedReply', () => {
  it('is an error node of kind cancelled, the kind the server writes on abort', () => {
    expect(isStoppedReply({ status: 'error', errorKind: 'cancelled' })).toBe(true);
    for (const errorKind of ['cut_off', 'provider', 'interrupted', null] as const)
      expect(isStoppedReply({ status: 'error', errorKind })).toBe(false);
    expect(isStoppedReply({ status: 'complete', errorKind: 'cancelled' })).toBe(false);
  });

  it('is a node stored without a kind that has the cancelled message', () => {
    expect(isStoppedReply({ status: 'error', error: REPLY_CANCELLED_ERROR })).toBe(true);
  });
});
