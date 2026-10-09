import type { MembershipInfo, ProviderInfo } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import {
  learnLessonHref,
  learnWay,
  lockedFundings,
  readOnlyText,
  routeLocked,
  routeOpen,
} from './read-only';

function membership(over: Partial<MembershipInfo> = {}): MembershipInfo {
  return {
    required: true,
    status: 'inactive',
    subscriptionStatus: 'canceled',
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
    ...over,
  };
}

function provider(over: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'OpenRouter',
    models: [],
    defaultModel: 'a/b',
    openModels: true,
    available: true,
    acceptsUserKey: true,
    keySource: 'user',
    funding: 'own-key',
    ...over,
  };
}

describe('lockedFundings and routeLocked', () => {
  it("locks what the server says needs the membership, only while the user hasn't one", () => {
    expect([...lockedFundings(['own-key'], membership())]).toEqual(['own-key']);
    expect([...lockedFundings(['own-key'], membership({ status: 'active' }))]).toEqual([]);
    expect([...lockedFundings(['own-key'], membership({ status: 'waived' }))]).toEqual([]);
    // No membership required (the fee off, a server without billing): never locked.
    expect([...lockedFundings(['own-key'], membership({ required: false }))]).toEqual([]);
    expect([...lockedFundings([], membership())]).toEqual([]);
    expect([...lockedFundings(undefined, null)]).toEqual([]);
  });

  it('reads a route without a funding as the own key', () => {
    const locked = lockedFundings(['own-key'], membership());
    expect(routeLocked(locked, {})).toBe(true);
    expect(routeLocked(locked, { funding: 'own-key' })).toBe(true);
    expect(routeLocked(locked, { funding: 'credit' })).toBe(false);
  });
});

describe('routeOpen', () => {
  const locked = lockedFundings(['own-key'], membership());
  const credit = provider({ funding: 'credit', acceptsUserKey: false, keySource: 'server' });

  it('needs a key, an unlocked funding and, for credit, credit to spend', () => {
    expect(routeOpen(provider(), new Set(), true)).toBe(true);
    expect(routeOpen(provider({ available: false }), new Set(), true)).toBe(false);
    expect(routeOpen(provider(), locked, true)).toBe(false);
    expect(routeOpen(credit, locked, true)).toBe(true);
    expect(routeOpen(credit, locked, false)).toBe(false);
  });
});

describe('readOnlyText', () => {
  it('asks a lapsed member to renew, and leaves Learn out where Learn could not reply', () => {
    expect(readOnlyText(membership())).toEqual({
      lead: 'Your membership has ended.',
      body: 'Renew your membership to continue this conversation.',
      act: 'Renew your membership',
      renew: 'Renew membership',
    });
  });

  it('offers Learn on the open pool while it is on', () => {
    expect(readOnlyText(membership(), false, 'pool').body).toBe(
      'Renew your membership to continue this conversation, or continue it in Learn on the open pool.',
    );
  });

  it('asks someone who never had one to become a member, and mentions credit when it can carry on', () => {
    const t = readOnlyText(membership({ subscriptionStatus: null }), true, 'credit');
    expect(t.lead).toBe('Replies on your own API keys need a membership.');
    expect(t.renew).toBe('Become a member');
    expect(t.body).toBe(
      'Become a member to continue this conversation, or continue it in Learn on Tangent credit. You can also continue it on Tangent credit, which needs no membership.',
    );
  });
});

describe('learnWay', () => {
  it('is the pool while it is on, else credit where it carries on, else nothing', () => {
    expect(learnWay(true, true)).toBe('pool');
    expect(learnWay(true, false)).toBe('pool');
    expect(learnWay(false, true)).toBe('credit');
    expect(learnWay(false, false)).toBeNull();
  });
});

describe('learnLessonHref', () => {
  it("links to Learn's lesson route, on a branch when one is named", () => {
    expect(learnLessonHref('abc')).toBe('/learn/t/abc');
    expect(learnLessonHref('a/b', 'c d')).toBe('/learn/t/a%2Fb/b/c%20d');
  });
});
