import { describe, expect, it } from 'vitest';
import {
  isCutOffReply,
  isLengthStop,
  REPLY_CUT_OFF_ERROR,
  REPLY_EMPTY_ERROR,
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

describe('isCutOffReply', () => {
  it('is an error node with the cut-off message, never another failure', () => {
    expect(isCutOffReply({ status: 'error', error: REPLY_CUT_OFF_ERROR })).toBe(true);
    for (const error of [REPLY_THINKING_ONLY_ERROR, REPLY_EMPTY_ERROR, 'Cancelled', null])
      expect(isCutOffReply({ status: 'error', error })).toBe(false);
    expect(isCutOffReply({ status: 'complete', error: REPLY_CUT_OFF_ERROR })).toBe(false);
  });
});
