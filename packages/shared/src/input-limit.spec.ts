import { describe, expect, it } from 'vitest';
import { contextLimitsQuerySchema, sendMessageRequestSchema } from './api.js';
import { inputBudgetOf } from './input-limit.js';

const ownKey = {
  contextTokens: 200_000,
  maxOutputTokens: 32_000,
  reasoning: false,
  serverMaxInputTokens: null,
};
const credit = {
  contextTokens: 60_000 + 16_384,
  maxOutputTokens: 16_384,
  reasoning: true,
  serverMaxInputTokens: 60_000,
};

describe('inputBudgetOf', () => {
  it('is the window less the reply without a limit, on the own key', () => {
    expect(inputBudgetOf(ownKey, { maxInputTokens: null, maxOutputTokens: null })).toEqual({
      defaultTokens: 200_000 - 4096,
      tokens: 200_000 - 4096,
      replyTokens: 4096,
      boundBy: 'window',
    });
    // A longer reply length leaves less room for input.
    expect(
      inputBudgetOf(ownKey, { maxInputTokens: null, maxOutputTokens: 32_768 }).defaultTokens,
    ).toBe(200_000 - 32_000);
  });

  it('is lowered by a limit, never raised', () => {
    expect(inputBudgetOf(ownKey, { maxInputTokens: 60_000, maxOutputTokens: null })).toMatchObject({
      tokens: 60_000,
      boundBy: 'limit',
    });
    expect(
      inputBudgetOf(ownKey, { maxInputTokens: 2_000_000, maxOutputTokens: null }),
    ).toMatchObject({ tokens: 200_000 - 4096, boundBy: 'window' });
  });

  it('stays within the server’s cap on Tangent credit', () => {
    expect(inputBudgetOf(credit, { maxInputTokens: null, maxOutputTokens: null })).toMatchObject({
      defaultTokens: 60_000,
      tokens: 60_000,
    });
    expect(
      inputBudgetOf(
        { ...credit, reasoning: false },
        { maxInputTokens: 200_000, maxOutputTokens: null },
      ),
    ).toMatchObject({ defaultTokens: 60_000, tokens: 60_000, boundBy: 'server' });
    expect(inputBudgetOf(credit, { maxInputTokens: 20_000, maxOutputTokens: null })).toMatchObject({
      tokens: 20_000,
      boundBy: 'limit',
    });
  });
});

describe('the input limit on the wire', () => {
  it('is accepted on a send within range, with a known over-limit choice', () => {
    expect(
      sendMessageRequestSchema.parse({
        content: 'Hi',
        maxInputTokens: 60_000,
        inputOverflow: 'truncate',
      }),
    ).toEqual({ content: 'Hi', maxInputTokens: 60_000, inputOverflow: 'truncate' });
    for (const bad of [
      { maxInputTokens: 999 },
      { maxInputTokens: 2_000_001 },
      { maxInputTokens: 1500.5 },
      { maxInputTokens: '60000' },
      { inputOverflow: 'forget' },
    ]) {
      expect(sendMessageRequestSchema.safeParse({ content: 'Hi', ...bad }).success).toBe(false);
    }
  });

  it('is read from the Context preview’s query string', () => {
    expect(
      contextLimitsQuerySchema.parse({
        maxInputTokens: '60000',
        maxOutputTokens: '8192',
        inputOverflow: 'compact',
      }),
    ).toEqual({ maxInputTokens: 60_000, maxOutputTokens: 8192, inputOverflow: 'compact' });
    expect(contextLimitsQuerySchema.parse({})).toEqual({});
    for (const bad of [
      { maxInputTokens: 'lots' },
      { maxInputTokens: '10' },
      { maxOutputTokens: '1' },
      { inputOverflow: 'x' },
    ]) {
      expect(contextLimitsQuerySchema.safeParse(bad).success).toBe(false);
    }
  });
});
