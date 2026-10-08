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
      tiers: { normal: null, max: null },
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
