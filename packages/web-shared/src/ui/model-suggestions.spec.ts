import '@angular/compiler'; // JIT: the component module below is decorated.
import { describe, expect, it } from 'vitest';
import { modelChips, suggestionText } from './model-suggestions';

describe('suggestionText', () => {
  it('names a suggested model by its label without the note, and adds the id', () => {
    expect(
      suggestionText({
        id: 'deepseek/deepseek-v4-pro',
        label: 'Normal (suggested)',
        tier: 'normal',
      }),
    ).toEqual({ name: 'Normal', id: 'deepseek-v4-pro' });
    expect(
      suggestionText({ id: 'anthropic/claude-sonnet-5.5', label: 'Max (suggested)', tier: 'max' }),
    ).toEqual({ name: 'Max', id: 'claude-sonnet-5.5' });
  });

  it('leaves out an id that only repeats the name', () => {
    expect(suggestionText({ id: 'max', label: 'Max (suggested)' })).toEqual({
      name: 'Max',
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

describe('modelChips', () => {
  it('names each listed model, and presses the one in the field', () => {
    const models = [
      { id: 'deepseek/deepseek-v4-pro', label: 'Normal (suggested)', tier: 'normal' as const },
      { id: 'openai/gpt-5', label: 'GPT-5' },
    ];
    expect(modelChips(models, ' openai/gpt-5 ')).toEqual([
      {
        model: 'deepseek/deepseek-v4-pro',
        text: { name: 'Normal', id: 'deepseek-v4-pro' },
        pressed: false,
      },
      { model: 'openai/gpt-5', text: { name: 'GPT-5', id: null }, pressed: true },
    ]);
  });
});
