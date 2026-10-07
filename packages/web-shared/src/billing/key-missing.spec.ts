import { describe, expect, it } from 'vitest';
import { addBlockedSend, keyMissing, keyMissingText } from './key-missing';

describe('keyMissing', () => {
  const entry = { available: false, acceptsUserKey: true, funding: 'own-key' as const };

  it('is a route on the user’s own key with none saved here', () => {
    expect(keyMissing(entry)).toBe(true);
    // A provider entry without a funding is the user's own key.
    expect(keyMissing({ available: false, acceptsUserKey: true })).toBe(true);
  });

  it('is never Tangent credit, a provider with a key, one that takes no user key, or none', () => {
    expect(keyMissing({ ...entry, funding: 'credit' })).toBe(false);
    expect(keyMissing({ ...entry, available: true })).toBe(false);
    expect(keyMissing({ ...entry, acceptsUserKey: false })).toBe(false);
    expect(keyMissing(undefined)).toBe(false);
  });
});

describe('addBlockedSend', () => {
  it('keeps one waiting message per branch, the latest last', () => {
    const list = addBlockedSend(addBlockedSend([], { branchId: 'a', content: '1' }), {
      branchId: 'b',
      content: '2',
    });
    expect(addBlockedSend(list, { branchId: 'a', content: '3' })).toEqual([
      { branchId: 'b', content: '2' },
      { branchId: 'a', content: '3' },
    ]);
  });
});

describe('keyMissingText', () => {
  it('names the branch and the provider, and every way on', () => {
    expect(keyMissingText('Primes', 'OpenRouter', true, true)).toEqual({
      lead: 'Your message wasn’t sent.',
      body:
        '“Primes” replies on OpenRouter with your own API key, and none is saved in this browser.' +
        ' To send it, continue it on Tangent credit, or enter your OpenRouter key below;' +
        ' any other provider or model is in the branch’s settings.',
    });
  });

  it('offers only what this server can do', () => {
    expect(keyMissingText('Primes', 'OpenRouter', false, true).body).toContain(
      'To send it, enter your OpenRouter key below;',
    );
    expect(keyMissingText('Primes', 'OpenRouter', true, false).body).toContain(
      'To send it, continue it on Tangent credit;',
    );
    expect(keyMissingText('Primes', 'OpenRouter', false, false).body).toContain(
      'To send it, pick another provider or model in the branch’s settings.',
    );
  });
});
