import { describe, expect, it } from 'vitest';
import type { ProviderConfig, ProviderKind } from '@tangent/shared';
import { providerTraits } from '../src/traits.js';

function config(kind: ProviderKind, baseUrl?: string): ProviderConfig {
  return {
    id: 'p',
    kind,
    label: 'P',
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    models: [{ id: 'm', label: 'M' }],
    defaultModel: 'm',
  };
}

const ROUTER = {
  webSearch: 'router',
  effort: 'openrouter-reasoning',
  routing: true,
  catalog: 'openrouter',
};
const PLAIN = { webSearch: 'router', effort: 'none', routing: false, catalog: null };
const NATIVE = { webSearch: 'native', effort: 'none', routing: false, catalog: null };
const ANTHROPIC = { ...NATIVE, effort: 'anthropic-effort' };

describe('providerTraits', () => {
  it.each([
    ['OpenRouter', config('openai-compatible', 'https://openrouter.ai/api/v1'), ROUTER],
    [
      'OpenRouter, trailing slash',
      config('openai-compatible', 'https://openrouter.ai/api/v1/'),
      ROUTER,
    ],
    [
      "AI Gateway's OpenRouter route",
      config('openai-compatible', 'https://gateway.ai.cloudflare.com/v1/acct/gw/openrouter'),
      ROUTER,
    ],
    ['OpenAI (the default endpoint)', config('openai-compatible'), PLAIN],
    [
      "a custom gateway's compat route",
      config('openai-compatible', 'https://gateway.ai.cloudflare.com/v1/acct/gw/compat'),
      PLAIN,
    ],
    ['a local server', config('openai-compatible', 'http://localhost:11434/v1'), PLAIN],
    ['an unparsable base URL', config('openai-compatible', 'not a url'), PLAIN],
    ['Anthropic', config('anthropic'), ANTHROPIC],
    [
      'Anthropic on an OpenRouter base URL',
      config('anthropic', 'https://openrouter.ai/api'),
      ANTHROPIC,
    ],
    ['the fake', config('fake'), NATIVE],
  ])('%s', (_name, c, expected) => {
    expect(providerTraits(c)).toMatchObject(expected);
  });

  it('marks cache breakpoints on openai-compatible endpoints only for `anthropic/` ids', () => {
    for (const c of [
      config('openai-compatible', 'https://openrouter.ai/api/v1'),
      config('openai-compatible'),
    ]) {
      const { explicitCacheMarkers } = providerTraits(c);
      expect(explicitCacheMarkers('anthropic/model-a')).toBe(true);
      expect(explicitCacheMarkers('~anthropic/model-a')).toBe(true);
      expect(explicitCacheMarkers('vendor/model-a')).toBe(false);
      expect(explicitCacheMarkers('claude-model-a')).toBe(false);
    }
  });

  it('marks every Anthropic model and no fake one', () => {
    expect(providerTraits(config('anthropic')).explicitCacheMarkers('claude-model-a')).toBe(true);
    expect(providerTraits(config('fake')).explicitCacheMarkers('anthropic/model-a')).toBe(false);
  });
});
