import { describe, expect, it } from 'vitest';
import {
  errorKindOf,
  failedStopError,
  isCutOffReply,
  isLengthStop,
  isStoppedReply,
  REPLY_CANCELLED_ERROR,
  REPLY_CUT_OFF_ERROR,
  REPLY_EMPTY_ERROR,
  REPLY_INTERRUPTED_ERROR,
  REPLY_REFUSED_ERROR,
  REPLY_STREAM_ENDED_ERROR,
  REPLY_THINKING_ONLY_ERROR,
  REPLY_UPSTREAM_ERROR,
} from './stop-reason.js';

describe('isLengthStop', () => {
  it('is true for the stops that cut a reply off, and only those', () => {
    // The output cap (OpenAI/OpenRouter, Anthropic), Anthropic's context window, and its
    // paused server-tool turn, which can't be resumed.
    for (const cut of ['length', 'max_tokens', 'model_context_window_exceeded', 'pause_turn'])
      expect(isLengthStop(cut)).toBe(true);
    for (const other of [
      'stop',
      'end_turn',
      'tool_calls',
      'content_filter',
      'refusal',
      'error',
      '',
      null,
      undefined,
    ])
      expect(isLengthStop(other)).toBe(false);
  });
});

describe('failedStopError', () => {
  it('fails a reply the model refused or the upstream ended with an error', () => {
    expect(failedStopError('refusal')).toBe(REPLY_REFUSED_ERROR);
    expect(failedStopError('error')).toBe(REPLY_UPSTREAM_ERROR);
  });

  it('is null for every other stop', () => {
    for (const other of ['stop', 'end_turn', 'length', 'max_tokens', 'pause_turn', '', null])
      expect(failedStopError(other)).toBeNull();
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
