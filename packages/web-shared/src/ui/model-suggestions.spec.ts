import '@angular/compiler'; // JIT: the component module below is decorated.
import { describe, expect, it } from 'vitest';
import { suggestionText } from './model-suggestions';

describe('suggestionText', () => {
  it('names a suggested model by its label without the note, and adds the id', () => {
    expect(suggestionText({ id: 'deepseek/deepseek-v4-pro', label: 'Smart (suggested)' })).toEqual({
      name: 'Smart',
      id: 'deepseek-v4-pro',
    });
    expect(
      suggestionText({ id: 'deepseek/deepseek-v4-flash', label: 'Simple (suggested)' }),
    ).toEqual({ name: 'Simple', id: 'deepseek-v4-flash' });
  });

  it('leaves out an id that only repeats the name', () => {
    expect(suggestionText({ id: 'smart', label: 'Smart (suggested)' })).toEqual({
      name: 'Smart',
      id: null,
    });
    expect(
      suggestionText({
        id: 'anthropic/claude-sonnet-5.5',
        label: 'Claude Sonnet 5.5 (OpenRouter)',
      }),
    ).toEqual({ name: 'Claude Sonnet 5.5', id: null });
    expect(suggestionText({ id: 'openai/gpt-5', label: 'GPT-5' })).toEqual({
      name: 'GPT-5',
      id: null,
    });
  });

  it('falls back to the id for an empty label', () => {
    expect(suggestionText({ id: 'vendor/model', label: '' })).toEqual({
      name: 'vendor/model',
      id: null,
    });
  });
});
