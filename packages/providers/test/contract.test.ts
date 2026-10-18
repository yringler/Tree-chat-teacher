import type { ProviderEvent } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { checkContract, foldStream } from './contract.js';

const usage: ProviderEvent = { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };

describe('foldStream and checkContract', () => {
  it('folds usage and billing field by field, later values winning', () => {
    const s = foldStream([
      { type: 'billing', generationId: 'gen-1' },
      { type: 'delta', text: 'a' },
      { type: 'usage', usage: { inputTokens: 1 } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'billing', costUsd: 0.001 },
      { type: 'done', stopReason: 'stop' },
    ]);
    expect(s.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(s.billing).toEqual({ generationId: 'gen-1', costUsd: 0.001 });
    expect(checkContract(s, { outcome: 'success', costReport: 'openrouter' }).failures).toEqual([]);
  });

  it('fails a stream without one terminal event last', () => {
    const none = foldStream([{ type: 'delta', text: 'a' }, usage]);
    expect(checkContract(none, { outcome: 'success' }).failures).toContain('no terminal event');
    const after = foldStream([usage, { type: 'done', stopReason: null }, usage]);
    expect(checkContract(after, { outcome: 'success' }).failures[0]).toMatch(/after the terminal/);
  });

  it('fails impossible token counts and a key in an error message', () => {
    const s = foldStream([
      {
        type: 'usage',
        usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 6, reasoningTokens: 3 },
      },
      { type: 'error', error: { code: 'auth', message: 'bad key sk-123456', retryable: false } },
    ]);
    const { failures } = checkContract(s, { outcome: 'error', error: { code: 'auth' } }, [
      'sk-123456',
    ]);
    expect(failures).toEqual([
      'cache read + write (6) exceed the input tokens (5)',
      'reasoning tokens (3) exceed the output tokens (2)',
      'the error message contains the key',
    ]);
  });

  it('checks a required search: one search and an https citation', () => {
    const s = foldStream([
      { type: 'delta', text: 'a' },
      usage,
      { type: 'billing', webSearches: 2 },
      { type: 'done', stopReason: 'stop' },
    ]);
    expect(checkContract(s, { outcome: 'success', search: { maxUses: 1 } }).failures).toEqual([
      '2 web searches, expected 1 to 1',
      'no https citation',
    ]);
  });
});
