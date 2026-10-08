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
      tiers: { normal: null, max: null },
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

describe('parseSettings tiers (Normal and Max)', () => {
  it('defaults both tiers to the suggested models, also for settings saved before tiers', () => {
    expect(DEFAULT_SETTINGS.tiers).toEqual({ normal: null, max: null });
    expect(parseSettings('{"reviewer":null}').tiers).toEqual({ normal: null, max: null });
    expect(parseSettings('{"tiers":"max"}').tiers).toEqual({ normal: null, max: null });
    expect(parseSettings('{"tiers":null}').tiers).toEqual({ normal: null, max: null });
  });

  it('reads each tier on its own and drops a malformed one', () => {
    expect(
      parseSettings(
        JSON.stringify({
          tiers: {
            normal: { providerId: 'openrouter', model: 'deepseek/deepseek-v4-pro' },
            max: {
              providerId: 'openrouter',
              funding: 'credit',
              model: 'anthropic/claude-sonnet-5.5',
            },
          },
        }),
      ).tiers,
    ).toEqual({
      normal: { providerId: 'openrouter', model: 'deepseek/deepseek-v4-pro' },
      max: { providerId: 'openrouter', funding: 'credit', model: 'anthropic/claude-sonnet-5.5' },
    });
    expect(
      parseSettings(
        '{"tiers":{"normal":{"providerId":"openrouter"},"max":{"providerId":"x","model":"y"}}}',
      ).tiers,
    ).toEqual({ normal: null, max: { providerId: 'x', model: 'y' } });
  });

  it('reads the legacy `tangent` provider as the built-in endpoint on credit', () => {
    expect(parseSettings('{"tiers":{"max":{"providerId":"tangent","model":"a/b"}}}').tiers).toEqual(
      {
        normal: null,
        max: { providerId: 'openrouter', funding: 'credit', model: 'a/b' },
      },
    );
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
