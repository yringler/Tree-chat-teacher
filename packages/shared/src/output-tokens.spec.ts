import { describe, expect, it } from 'vitest';
import {
  auxOutputTokens,
  formatTokenCount,
  isReasoningModel,
  REASONING_REPLY_OUTPUT_TOKENS,
  replyOutputTokens,
} from './output-tokens.js';
import { sendMessageRequestSchema } from './api.js';

describe('isReasoningModel', () => {
  it('knows the reasoning families, as OpenRouter ids and bare ids', () => {
    for (const id of [
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-r1',
      'deepseek-reasoner',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-opus-4.6',
      'anthropic/claude-sonnet-4.5',
      'claude-opus-5-5',
      'claude-sonnet-4-5-20250929',
      'openai/o3-mini',
      'o4-mini',
      'openai/gpt-5',
      'openai/gpt-oss-120b',
      'google/gemini-2.5-flash',
      'google/gemini-3-pro',
      'x-ai/grok-4',
      'qwen/qwen3-235b-a22b',
      'moonshotai/kimi-k2-thinking',
      'z-ai/glm-4.6',
      'some/new-model-thinking',
      'DeepSeek/DeepSeek-V4-Pro',
    ])
      expect(isReasoningModel(id), id).toBe(true);
  });

  it('leaves other models alone', () => {
    for (const id of [
      'deepseek/deepseek-chat-v3',
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-sonnet-4',
      'claude-haiku-3-5',
      'openai/gpt-4o',
      'openai/gpt-4.1-mini',
      'google/gemini-2.0-flash',
      'meta-llama/llama-3.3-70b-instruct',
      'mistralai/mistral-large',
      'fake-1',
      'max',
      'm1',
    ])
      expect(isReasoningModel(id), id).toBe(false);
  });
});

describe('replyOutputTokens', () => {
  it('defaults to 4,096, or 16,384 on a reasoning model', () => {
    expect(replyOutputTokens({ reasoning: false, maxOutputTokens: 100_000 })).toBe(4096);
    expect(replyOutputTokens({ reasoning: true, maxOutputTokens: 100_000 })).toBe(
      REASONING_REPLY_OUTPUT_TOKENS,
    );
  });

  it('never exceeds the model limit', () => {
    expect(replyOutputTokens({ reasoning: true, maxOutputTokens: 8192 })).toBe(8192);
    expect(replyOutputTokens({ reasoning: false, maxOutputTokens: 1000 })).toBe(1000);
    expect(replyOutputTokens({ reasoning: true, maxOutputTokens: 32_000, requested: 64_000 })).toBe(
      32_000,
    );
  });

  it('takes a requested cap over the default, either way', () => {
    const base = { maxOutputTokens: 100_000 };
    expect(replyOutputTokens({ ...base, reasoning: false, requested: 12_000 })).toBe(12_000);
    expect(replyOutputTokens({ ...base, reasoning: true, requested: 2000 })).toBe(2000);
    expect(replyOutputTokens({ ...base, reasoning: true, requested: null })).toBe(16_384);
  });

  it('takes the caller’s defaults', () => {
    const defaults = { plain: 1024, reasoning: 2048 };
    expect(replyOutputTokens({ reasoning: false, maxOutputTokens: 9999, defaults })).toBe(1024);
    expect(replyOutputTokens({ reasoning: true, maxOutputTokens: 9999, defaults })).toBe(2048);
  });
});

describe('auxOutputTokens', () => {
  it('is 1,024, or up to 4,096 on a reasoning model (never under 1,024)', () => {
    expect(auxOutputTokens({ maxOutputTokens: 100_000 })).toBe(1024);
    expect(auxOutputTokens({ reasoning: false, maxOutputTokens: 100 })).toBe(1024);
    expect(auxOutputTokens({ reasoning: true, maxOutputTokens: 100_000 })).toBe(4096);
    expect(auxOutputTokens({ reasoning: true, maxOutputTokens: 2048 })).toBe(2048);
    expect(auxOutputTokens({ reasoning: true, maxOutputTokens: 512 })).toBe(1024);
  });
});

describe('formatTokenCount', () => {
  it('writes token counts the way the settings show them', () => {
    expect(formatTokenCount(512)).toBe('512');
    expect(formatTokenCount(4096)).toBe('4k');
    expect(formatTokenCount(16_384)).toBe('16k');
    expect(formatTokenCount(32_768)).toBe('32k');
    expect(formatTokenCount(32_000)).toBe('32k');
    expect(formatTokenCount(1500)).toBe('1.5k');
    expect(formatTokenCount(128_000)).toBe('128k');
  });
});

describe('sendMessageRequestSchema.maxOutputTokens', () => {
  it('accepts a whole number in range, and nothing else', () => {
    expect(sendMessageRequestSchema.parse({ content: 'x', maxOutputTokens: 8192 })).toEqual({
      content: 'x',
      maxOutputTokens: 8192,
    });
    expect(sendMessageRequestSchema.parse({ content: 'x' })).toEqual({ content: 'x' });
    for (const bad of [255, 128_001, 4096.5, '4096', null])
      expect(
        sendMessageRequestSchema.safeParse({ content: 'x', maxOutputTokens: bad }).success,
        String(bad),
      ).toBe(false);
  });
});
