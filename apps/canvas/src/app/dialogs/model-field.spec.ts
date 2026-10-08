import '@angular/compiler'; // JIT: the component module below is decorated.
import type { ProviderInfo } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { laneRoute, modelHint, routeSuffix } from './model-field';

const base: ProviderInfo = {
  id: 'openrouter',
  kind: 'openai-compatible',
  label: 'OpenRouter',
  models: [{ id: 'vendor/listed', label: 'Listed' }],
  defaultModel: 'vendor/listed',
  openModels: true,
  available: true,
  acceptsUserKey: true,
  keySource: 'user',
};

describe('modelHint (canvas)', () => {
  it('accepts any well-formed id on an open provider and flags the rest', () => {
    expect(modelHint(base, 'vendor/unlisted-model')).toBeNull();
    expect(modelHint(base, '')).toMatch(/Enter a model id/);
    expect(modelHint(base, 'not an id')).toMatch(/Not a model id/);
  });

  it('says nothing for a closed provider', () => {
    expect(modelHint({ ...base, openModels: false }, 'not an id')).toBeNull();
  });
});

describe('routeSuffix (canvas)', () => {
  it('marks a route needing a membership the user lacks, after a missing key', () => {
    expect(routeSuffix(base, false)).toBe('');
    expect(routeSuffix(base, true)).toBe(' — needs a membership');
    expect(routeSuffix({ ...base, available: false }, true)).toBe(' — missing API key');
    expect(routeSuffix({ ...base, available: false, acceptsUserKey: false }, false)).toBe(
      ' — unavailable',
    );
  });
});

describe('laneRoute', () => {
  const credit: ProviderInfo = {
    ...base,
    label: 'Tangent credit',
    acceptsUserKey: false,
    keySource: 'server',
    funding: 'credit',
    defaultModel: 'vendor/default',
  };
  const parent = { providerId: 'openrouter', funding: 'own-key' as const, model: 'vendor/x' };

  it('keeps a usable parent lane’s route and model', () => {
    expect(laneRoute(parent, true, credit)).toEqual(parent);
  });

  it('a locked (or keyless) parent hands over to the default route, keeping a model it serves', () => {
    expect(laneRoute(parent, false, credit)).toEqual({
      providerId: 'openrouter',
      funding: 'credit',
      model: 'vendor/x',
    });
    const closed = { ...credit, id: 'other', openModels: false };
    expect(laneRoute(parent, false, closed)).toEqual({
      providerId: 'other',
      funding: 'credit',
      model: 'vendor/default',
    });
  });

  it('with no parent lane, the default route', () => {
    expect(laneRoute(null, false, credit)).toEqual({
      providerId: 'openrouter',
      funding: 'credit',
      model: 'vendor/default',
    });
    expect(laneRoute(null, false, null)).toEqual({ providerId: '', funding: 'own-key', model: '' });
  });
});
