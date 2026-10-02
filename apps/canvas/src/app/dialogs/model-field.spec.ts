import '@angular/compiler'; // JIT: the component module below is decorated.
import type { ProviderInfo } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { modelHint } from './model-field';

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
