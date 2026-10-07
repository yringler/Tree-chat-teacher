import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_MODE } from '@tangent/web-shared';
import { PaymentStore } from './payment-store';

function create(demo = false): PaymentStore {
  return Injector.create({
    providers: [{ provide: PaymentStore }, { provide: DEMO_MODE, useValue: demo }],
  }).get(PaymentStore);
}

describe('PaymentStore', () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs on the own key until the server says it sells credit', () => {
    const p = create();
    expect(p.payment()).toBe('own-key');
    expect(p.headers()).toEqual({ 'x-tangent-mode': 'simple', 'x-tangent-payment': 'own-key' });
    p.builtInCredit.set(true);
    // A member whose key status isn't known yet stays on the key...
    expect(p.payment()).toBe('own-key');
    // ... and one known to hold no key goes on credit, which anyone can buy.
    p.hasOwnKey.set(false);
    expect(p.headers()).toEqual({ 'x-tangent-mode': 'simple', 'x-tangent-payment': 'credit' });
  });

  it('remembers the choice, which applies only while credit is offered', () => {
    const p = create();
    p.builtInCredit.set(true);
    p.choose('own-key');
    expect(storage.get('tangent.learn.payment')).toBe('own-key');
    expect(p.payment()).toBe('own-key');

    const again = create();
    again.builtInCredit.set(true);
    expect(again.payment()).toBe('own-key');
    again.choose('credit');
    expect(again.payment()).toBe('credit');
    again.builtInCredit.set(false);
    expect(again.payment()).toBe('own-key');
  });

  it('remembers a pool choice (and ignores anything unknown)', () => {
    storage.set('tangent.learn.payment', 'pool');
    const p = create();
    p.builtInCredit.set(true);
    p.poolAvailable.set(true);
    expect(p.payment()).toBe('pool');
    expect(p.headers()).toEqual({ 'x-tangent-mode': 'simple', 'x-tangent-payment': 'pool' });
    storage.set('tangent.learn.payment', 'free');
    const q = create();
    q.builtInCredit.set(true);
    q.hasOwnKey.set(false);
    expect(q.payment()).toBe('credit');
  });

  it('defaults to what can reply right away: credit with a balance, a member’s key, the pool, credit to buy, the own key', () => {
    const p = create();
    p.builtInCredit.set(true);
    p.poolAvailable.set(true);
    p.creditAvailableMicros.set(0);
    // 2. A member's saved key (or one whose status isn't known yet) beats an empty balance.
    expect(p.payment()).toBe('own-key');
    p.hasOwnKey.set(true);
    expect(p.payment()).toBe('own-key');
    // 1. Credit with a balance beats the key.
    p.creditAvailableMicros.set(1);
    expect(p.payment()).toBe('credit');
    // 3. No key, no balance: the pool while it is on.
    p.creditAvailableMicros.set(0);
    p.hasOwnKey.set(false);
    expect(p.payment()).toBe('pool');
    // 4. The pool off: credit, where it can be bought.
    p.poolAvailable.set(false);
    expect(p.payment()).toBe('credit');
    // 5. Credit that can't be bought (top-ups off, nothing left), or not sold: the own key.
    p.topUpsEnabled.set(false);
    expect(p.payment()).toBe('own-key');
    p.topUpsEnabled.set(true);
    p.builtInCredit.set(false);
    expect(p.payment()).toBe('own-key');
  });

  it('a new non-member: the pool while it is on, unless a balance is left; else credit to buy', () => {
    const p = create();
    p.member.set(false);
    p.hasOwnKey.set(false);
    p.builtInCredit.set(true);
    p.poolAvailable.set(true);
    p.creditAvailableMicros.set(0);
    expect(p.payment()).toBe('pool');
    p.creditAvailableMicros.set(250_000);
    expect(p.payment()).toBe('credit');
    // The pool off, nothing left, top-ups sold: credit (anyone can buy it).
    p.poolAvailable.set(false);
    p.creditAvailableMicros.set(0);
    expect(p.payment()).toBe('credit');
  });

  it('a member with a saved key: the key while no credit is left, credit with a balance', () => {
    const p = create();
    p.hasOwnKey.set(true);
    p.builtInCredit.set(true);
    p.poolAvailable.set(true);
    p.creditAvailableMicros.set(0);
    expect(p.payment()).toBe('own-key');
    p.creditAvailableMicros.set(1_000_000);
    expect(p.payment()).toBe('credit');
  });

  it('before the balance is read: a member keeps the key; between the pool and credit, credit', () => {
    // The server moves a credit send it can't pay onto the pool while the pool is on, so an
    // unknown balance never picks the pool over credit the learner may hold.
    const p = create();
    p.member.set(false);
    p.builtInCredit.set(true);
    p.poolAvailable.set(true);
    expect(p.creditAvailableMicros()).toBeNull();
    expect(p.payment()).toBe('credit');
    p.creditAvailableMicros.set(0);
    expect(p.payment()).toBe('pool');
    // A member with a saved key is never moved off it on a guess.
    const q = create();
    q.builtInCredit.set(true);
    q.poolAvailable.set(true);
    q.hasOwnKey.set(true);
    expect(q.payment()).toBe('own-key');
  });

  it('a saved key with no choice made stays on the key where credit is not sold', () => {
    const p = create();
    p.poolAvailable.set(true);
    p.hasOwnKey.set(true);
    expect(p.payment()).toBe('own-key');
    expect(p.headers()).toEqual({ 'x-tangent-mode': 'simple', 'x-tangent-payment': 'own-key' });
    // A stale credit choice on a server that stopped selling it: the key too.
    p.choose('credit');
    expect(p.payment()).toBe('own-key');
    // Only an explicit pool choice outranks the saved key.
    p.choose('pool');
    expect(p.payment()).toBe('pool');
  });

  it('credit is usable by anyone where top-ups are sold, membership or not, with no balance', () => {
    const p = create();
    p.builtInCredit.set(true);
    p.member.set(false);
    p.creditAvailableMicros.set(0);
    expect(p.creditUsable()).toBe(true);
    expect(p.payment()).toBe('credit');
    // With top-ups off, only a balance left can pay.
    p.topUpsEnabled.set(false);
    expect(p.creditUsable()).toBe(false);
    p.creditAvailableMicros.set(250_000);
    expect(p.creditUsable()).toBe(true);
    expect(p.payment()).toBe('credit');
  });

  it('a non-member never lands on their own key unasked: the pool, else credit', () => {
    const p = create();
    p.poolAvailable.set(true);
    p.hasOwnKey.set(true);
    p.member.set(false);
    // Credit not sold, a saved key: the pool, not a 402 on the key.
    expect(p.payment()).toBe('pool');
    // The key status not known yet: the pool too.
    p.hasOwnKey.set(null);
    expect(p.payment()).toBe('pool');
    // Credit sold but nothing left: still the pool; with the pool off, credit.
    p.builtInCredit.set(true);
    p.creditAvailableMicros.set(0);
    expect(p.payment()).toBe('pool');
    p.poolAvailable.set(false);
    expect(p.payment()).toBe('credit');
    // Nothing else on offer: the own key (the composer gives way to the locked-key notice).
    p.builtInCredit.set(false);
    expect(p.payment()).toBe('own-key');
    // A member with a saved key, no choice made, credit not sold: the key.
    p.poolAvailable.set(true);
    p.hasOwnKey.set(true);
    p.member.set(true);
    expect(p.payment()).toBe('own-key');
  });

  it('an explicit own-key choice stands for a non-member (the locked-key notice explains, rather than a 402)', () => {
    const p = create();
    p.builtInCredit.set(true);
    p.poolAvailable.set(true);
    p.member.set(false);
    p.choose('own-key');
    expect(p.payment()).toBe('own-key');
  });

  it('an explicit pool choice applies for a non-member, even with credit left, while the pool is on', () => {
    const p = create();
    p.member.set(false);
    p.hasOwnKey.set(true);
    p.builtInCredit.set(true);
    p.creditAvailableMicros.set(1_000_000);
    p.poolAvailable.set(true);
    expect(p.payment()).toBe('credit');
    p.choose('pool');
    expect(p.payment()).toBe('pool');
    // The pool switched off: back to the default (credit with its balance).
    p.poolAvailable.set(false);
    expect(p.payment()).toBe('credit');
  });

  it("a stored credit choice falls back when credit isn't usable", () => {
    storage.set('tangent.learn.payment', 'credit');
    const p = create();
    p.member.set(false);
    p.builtInCredit.set(true);
    p.poolAvailable.set(true);
    p.creditAvailableMicros.set(0);
    // Top-ups sold: an empty balance can be refilled, so the choice stands.
    expect(p.payment()).toBe('credit');
    // Top-ups off and nothing left: the pool while it is on, else the own key.
    p.topUpsEnabled.set(false);
    expect(p.payment()).toBe('pool');
    p.poolAvailable.set(false);
    expect(p.payment()).toBe('own-key');
    // Credit no longer sold: the same.
    p.topUpsEnabled.set(true);
    p.builtInCredit.set(false);
    expect(p.payment()).toBe('own-key');
  });

  it('a member is back on credit when chosen', () => {
    const p = create();
    p.hasOwnKey.set(true);
    p.builtInCredit.set(true);
    p.poolAvailable.set(true);
    p.creditAvailableMicros.set(0);
    p.choose('own-key');
    expect(p.payment()).toBe('own-key');
    // Chosen with nothing left: credit all the same (top-ups are sold, so it can be bought).
    p.choose('credit');
    expect(p.payment()).toBe('credit');
  });

  it('round-trips each stored choice', () => {
    for (const choice of ['own-key', 'credit', 'pool'] as const) {
      create().choose(choice);
      const again = create();
      again.builtInCredit.set(true);
      again.poolAvailable.set(true);
      expect(again.payment()).toBe(choice);
    }
  });

  it('the demo always uses its pretend credit', () => {
    storage.set('tangent.learn.payment', 'own-key');
    expect(create(true).payment()).toBe('credit');
  });
});
