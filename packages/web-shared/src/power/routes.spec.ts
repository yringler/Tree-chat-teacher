import type { ProviderInfo } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { modelHint, routeSuffix, startingRoute } from './routes';

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

describe('routeSuffix', () => {
  it('says a route needs a membership when its funding is locked, else why it is unavailable', () => {
    expect(routeSuffix(provider(), false)).toBe('');
    expect(routeSuffix(provider(), true)).toBe(' — needs a membership');
    // No key at all: adding one comes first.
    expect(routeSuffix(provider({ available: false }), true)).toBe(' — missing API key');
    expect(routeSuffix(provider({ available: false }), false)).toBe(' — missing API key');
    // A missing key is named only where the user could add one.
    expect(routeSuffix(provider({ available: false, acceptsUserKey: false }), false)).toBe(
      ' — unavailable',
    );
  });
});

describe('startingRoute', () => {
  const credit = provider({
    id: 'openrouter',
    label: 'Tangent credit',
    models: [{ id: 'vendor/listed', label: 'Listed' }],
    openModels: true,
    acceptsUserKey: false,
    keySource: 'server',
    funding: 'credit',
    defaultModel: 'vendor/default',
  });
  const parent = { providerId: 'openrouter', funding: 'own-key' as const, model: 'vendor/x' };

  it('keeps a usable parent’s route and model', () => {
    expect(startingRoute(parent, true, credit)).toEqual(parent);
  });

  it('a locked (or keyless) parent hands over to the default route, keeping a model it serves', () => {
    expect(startingRoute(parent, false, credit)).toEqual({
      providerId: 'openrouter',
      funding: 'credit',
      model: 'vendor/x',
    });
    const closed = { ...credit, id: 'other', openModels: false };
    expect(startingRoute(parent, false, closed)).toEqual({
      providerId: 'other',
      funding: 'credit',
      model: 'vendor/default',
    });
  });

  it('with no parent, the default route; with neither, an empty one', () => {
    expect(startingRoute(null, false, credit)).toEqual({
      providerId: 'openrouter',
      funding: 'credit',
      model: 'vendor/default',
    });
    expect(startingRoute(null, false, null)).toEqual({
      providerId: '',
      funding: 'own-key',
      model: '',
    });
    expect(startingRoute(parent, false, null)).toEqual({
      providerId: '',
      funding: 'own-key',
      model: '',
    });
  });
});
