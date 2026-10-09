import { describe, expect, it } from 'vitest';
import {
  isCutOffReply,
  isLengthStop,
  isStoppedReply,
  REPLY_CANCELLED_ERROR,
  REPLY_CUT_OFF_ERROR,
} from './stop-reason.js';

describe('isLengthStop', () => {
  it('is true for the output cap (OpenAI/OpenRouter `length`, Anthropic `max_tokens`) only', () => {
    expect(isLengthStop('length')).toBe(true);
    expect(isLengthStop('max_tokens')).toBe(true);
    for (const other of ['stop', 'end_turn', 'tool_calls', 'content_filter', '', null, undefined])
      expect(isLengthStop(other)).toBe(false);
  });
});

describe('isCutOffReply', () => {
  it('is an error node of kind cut_off, never another failure, whatever its copy', () => {
    expect(isCutOffReply({ status: 'error', errorKind: 'cut_off' })).toBe(true);
    for (const errorKind of ['thinking_only', 'empty', 'cancelled', 'provider', null] as const)
      expect(isCutOffReply({ status: 'error', errorKind })).toBe(false);
    // The copy alone (a node without a kind) is no cut-off.
    const copyOnly = { status: 'error', error: REPLY_CUT_OFF_ERROR } as const;
    expect(isCutOffReply(copyOnly)).toBe(false);
    expect(isCutOffReply({ status: 'complete', errorKind: 'cut_off' })).toBe(false);
  });
});

describe('isStoppedReply', () => {
  it('is an error node of kind cancelled, the kind the server writes on abort', () => {
    expect(isStoppedReply({ status: 'error', errorKind: 'cancelled' })).toBe(true);
    for (const errorKind of ['cut_off', 'provider', 'interrupted', null] as const)
      expect(isStoppedReply({ status: 'error', errorKind })).toBe(false);
    const copyOnly = { status: 'error', error: REPLY_CANCELLED_ERROR } as const;
    expect(isStoppedReply(copyOnly)).toBe(false);
    expect(isStoppedReply({ status: 'complete', errorKind: 'cancelled' })).toBe(false);
  });
});
