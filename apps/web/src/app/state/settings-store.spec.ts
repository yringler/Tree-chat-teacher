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
});
