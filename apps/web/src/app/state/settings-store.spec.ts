import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseOutputTokens, parseSettings } from './settings-store';

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
      maxOutputTokens: null,
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

describe('the reply length (maxOutputTokens)', () => {
  it('defaults to Auto (null) and reads a saved cap', () => {
    expect(parseSettings(null).maxOutputTokens).toBeNull();
    expect(parseSettings('{"maxOutputTokens":16384}').maxOutputTokens).toBe(16_384);
    expect(parseSettings('{"maxOutputTokens":null,"reviewer":null}')).toEqual(DEFAULT_SETTINGS);
  });

  it('drops anything a send would be refused for', () => {
    for (const bad of [255, 128_001, 4096.5, '4096', true, -1, Number.NaN])
      expect(parseOutputTokens(bad), String(bad)).toBeNull();
    expect(parseOutputTokens(256)).toBe(256);
    expect(parseOutputTokens(128_000)).toBe(128_000);
    expect(parseSettings('{"maxOutputTokens":"lots"}').maxOutputTokens).toBeNull();
  });
});
