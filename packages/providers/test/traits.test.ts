import { describe, expect, it } from 'vitest';
import type { ProviderConfig, ProviderKind } from '@tangent/shared';
import { billsCacheWritePremium } from '../src/prompt-cache.js';
import {
  ANTHROPIC_WEB_SEARCH_FEE_MICROS,
  providerTraits,
  unreportedSearchFeeMicros,
} from '../src/traits.js';

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
const PLAIN = { webSearch: 'none', effort: 'none', routing: false, catalog: null };
const OPENAI = { ...PLAIN, effort: 'openai-reasoning_effort' };
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
    ['OpenAI (the default endpoint)', config('openai-compatible'), OPENAI],
    ['OpenAI by its URL', config('openai-compatible', 'https://api.openai.com/v1'), OPENAI],
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

describe('billsCacheWritePremium', () => {
  it.each([
    ['claude-haiku-5-5', true],
    ['claude-sonnet-5-5', true],
    ['anthropic/claude-sonnet-5.5', true],
    ['~anthropic/claude-sonnet-latest', true],
    ['deepseek/deepseek-v4.1-flash', false],
    ['openai/gpt-5', false],
    ['deepseek/claude-like', false],
  ])('%s → %s', (model, expected) => {
    expect(billsCacheWritePremium(model)).toBe(expected);
  });
});

describe('unreportedSearchFeeMicros', () => {
  it("is Anthropic's $10 per 1,000 searches, and nothing where a reported cost holds the fee", () => {
    expect(unreportedSearchFeeMicros('anthropic')).toBe(ANTHROPIC_WEB_SEARCH_FEE_MICROS);
    expect(ANTHROPIC_WEB_SEARCH_FEE_MICROS).toBe(10_000);
    expect(unreportedSearchFeeMicros('openai-compatible')).toBe(0);
    expect(unreportedSearchFeeMicros('fake')).toBe(0);
  });
});
