import { describe, expect, it } from 'vitest';
import { isModelAllowed, isReasoningEffort, OPEN_MODEL_ID_PATTERN } from './provider.js';

const listed = [{ id: 'max', label: 'Max' }];

describe('isModelAllowed', () => {
  it('a closed list allows only its models; an empty one allows any', () => {
    expect(isModelAllowed({ models: listed, openModels: false }, 'max')).toBe(true);
    expect(isModelAllowed({ models: listed, openModels: false }, 'vendor/other')).toBe(false);
    expect(isModelAllowed({ models: [], openModels: false }, 'anything')).toBe(true);
  });

  it('an open list allows any well-formed model id', () => {
    const open = { models: listed, openModels: true };
    for (const id of ['max', 'deepseek/deepseek-v4-pro', 'openai/gpt-5:online', 'a.b_c-d']) {
      expect(isModelAllowed(open, id), id).toBe(true);
    }
    for (const id of ['', ' x', 'has space', '/leading', 'x'.repeat(201), 'a?b', 'a\nb']) {
      expect(isModelAllowed(open, id), id).toBe(false);
    }
    expect(OPEN_MODEL_ID_PATTERN.test('x'.repeat(200))).toBe(true);
  });
});

describe('isReasoningEffort', () => {
  it('accepts none, low and high; never max', () => {
    for (const e of ['none', 'low', 'high']) expect(isReasoningEffort(e)).toBe(true);
    for (const e of ['max', 'xhigh', 'medium', 'minimal', 'off', '', null, 3])
      expect(isReasoningEffort(e)).toBe(false);
  });
});
