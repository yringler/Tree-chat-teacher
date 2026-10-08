import '@angular/compiler'; // JIT: the component module below is decorated.
import type { ProviderInfo } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { effectiveOutputCap } from './output-cap-setting';

function provider(over: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'OpenRouter',
    models: [],
    defaultModel: 'deepseek/deepseek-v4-pro',
    openModels: true,
    available: true,
    acceptsUserKey: true,
    keySource: 'user',
    funding: 'own-key',
    ...over,
  };
}

describe('effectiveOutputCap', () => {
  it('is Auto’s default for the model: 16k on a reasoning model, 4k otherwise', () => {
    const own = provider();
    expect(effectiveOutputCap(null, { model: 'deepseek/deepseek-v4-pro', provider: own })).toEqual({
      tokens: 16_384,
      reasoning: true,
      limit: null,
    });
    expect(effectiveOutputCap(null, { model: 'openai/gpt-4o', provider: own })).toMatchObject({
      tokens: 4096,
      reasoning: false,
    });
  });

  it('is the chosen cap, within Tangent credit’s limit or a listed model’s', () => {
    const credit = provider({ funding: 'credit' });
    expect(
      effectiveOutputCap(32_768, { model: 'anthropic/claude-sonnet-5.5', provider: credit }),
    ).toEqual({ tokens: 16_384, reasoning: true, limit: 16_384 });
    expect(effectiveOutputCap(8192, { model: 'openai/gpt-4o', provider: credit }).tokens).toBe(
      8192,
    );
    const listed = provider({
      models: [{ id: 'mine', label: 'Mine', maxOutputTokens: 6000, reasoning: true }],
    });
    expect(effectiveOutputCap(null, { model: 'mine', provider: listed })).toEqual({
      tokens: 6000,
      reasoning: true,
      limit: 6000,
    });
    // Unknown provider (not loaded yet): no limit to apply.
    expect(effectiveOutputCap(50_000, { model: 'x', provider: undefined }).tokens).toBe(50_000);
  });
});
