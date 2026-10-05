import '@angular/compiler'; // JIT: the component module below is decorated.
import type { ProviderInfo } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { modelHint, routeSuffix, unavailableSuffix } from './model-picker';

function provider(over: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic',
    models: [{ id: 'listed-model', label: 'Listed' }],
    defaultModel: 'listed-model',
    openModels: false,
    available: true,
    acceptsUserKey: true,
    keySource: 'user',
    ...over,
  };
}

describe('modelHint', () => {
  it('says nothing for a closed provider: its select only offers listed models', () => {
    expect(modelHint(provider(), 'anything at all')).toBeNull();
    expect(modelHint(null, '')).toBeNull();
  });

  it('takes any well-formed id on an open provider, listed or not', () => {
    const open = provider({ id: 'openrouter', openModels: true });
    expect(modelHint(open, 'listed-model')).toBeNull();
    expect(modelHint(open, 'deepseek/deepseek-v4-pro')).toBeNull();
    expect(modelHint(open, 'openai/gpt-5:online')).toBeNull();
  });

  it('flags an empty or malformed id on an open provider', () => {
    const open = provider({
      id: 'openrouter',
      funding: 'credit',
      openModels: true,
      acceptsUserKey: false,
    });
    expect(modelHint(open, '  ')).toMatch(/Enter a model id/);
    expect(modelHint(open, 'two words')).toMatch(/Not a model id/);
    expect(modelHint(open, '/leading-slash')).toMatch(/Not a model id/);
  });
});

describe('unavailableSuffix', () => {
  it('names the missing key only where the user could add one', () => {
    expect(unavailableSuffix(provider())).toBe('');
    expect(unavailableSuffix(provider({ available: false }))).toBe(' — missing API key');
    expect(unavailableSuffix(provider({ available: false, acceptsUserKey: false }))).toBe(
      ' — unavailable',
    );
  });
});

describe('routeSuffix', () => {
  it('says a route needs a membership when its funding is locked, else why it is unavailable', () => {
    expect(routeSuffix(provider(), false)).toBe('');
    expect(routeSuffix(provider(), true)).toBe(' — needs a membership');
    // No key at all: adding one comes first.
    expect(routeSuffix(provider({ available: false }), true)).toBe(' — missing API key');
  });
});
