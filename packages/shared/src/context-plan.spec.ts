import { describe, expect, it } from 'vitest';
import { foldSystemPrompt } from './context-plan.js';

describe('foldSystemPrompt', () => {
  it('puts the system text in front of the first user message', () => {
    expect(
      foldSystemPrompt({
        system: 'Be brief.',
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello' },
        ],
      }),
    ).toEqual({
      system: null,
      messages: [
        { role: 'user', content: 'Be brief.\n\nHi' },
        { role: 'assistant', content: 'Hello' },
      ],
    });
  });

  it('gives it a user message of its own before a leading assistant message, or alone', () => {
    expect(
      foldSystemPrompt({ system: 'S', messages: [{ role: 'assistant', content: 'A' }] }),
    ).toEqual({
      system: null,
      messages: [
        { role: 'user', content: 'S' },
        { role: 'assistant', content: 'A' },
      ],
    });
    expect(foldSystemPrompt({ system: 'S', messages: [] })).toEqual({
      system: null,
      messages: [{ role: 'user', content: 'S' }],
    });
  });

  it('leaves a prompt without system text as it is', () => {
    const prompt = { system: null, messages: [{ role: 'user' as const, content: 'Hi' }] };
    expect(foldSystemPrompt(prompt)).toBe(prompt);
  });
});
