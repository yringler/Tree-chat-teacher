import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings } from './settings-store';

describe('parseSettings', () => {
  it('returns defaults for missing or malformed data', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{oops')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('42')).toEqual(DEFAULT_SETTINGS);
  });

  it('reads a saved reviewer and drops a malformed one', () => {
    expect(
      parseSettings('{"reviewer":{"providerId":"anthropic","model":"claude-opus-5-5"}}'),
    ).toEqual({
      reviewer: { providerId: 'anthropic', model: 'claude-opus-5-5' },
    });
    expect(parseSettings('{"reviewer":{"providerId":"anthropic"}}').reviewer).toBeNull();
    expect(parseSettings('{"reviewer":"opus"}').reviewer).toBeNull();
  });

  it('keeps a reviewer on Tangent credit, and reads the legacy `tangent` as one', () => {
    expect(
      parseSettings('{"reviewer":{"providerId":"openrouter","funding":"credit","model":"a/b"}}')
        .reviewer,
    ).toEqual({ providerId: 'openrouter', funding: 'credit', model: 'a/b' });
    expect(parseSettings('{"reviewer":{"providerId":"tangent","model":"a/b"}}').reviewer).toEqual({
      providerId: 'openrouter',
      funding: 'credit',
      model: 'a/b',
    });
    // An unknown funding is dropped: the user's own key.
    expect(
      parseSettings('{"reviewer":{"providerId":"openrouter","funding":"free","model":"a/b"}}')
        .reviewer,
    ).toEqual({ providerId: 'openrouter', model: 'a/b' });
  });
});
