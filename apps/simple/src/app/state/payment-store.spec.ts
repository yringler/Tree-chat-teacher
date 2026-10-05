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
    // Credit is the default where it is offered.
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
    expect(q.payment()).toBe('credit');
  });

  it('falls back: credit if sold, else a saved or unknown key, else the pool if on, else the own key', () => {
    const p = create();
    // Nothing chosen, credit not sold, the key status not known yet: the own key.
    p.poolAvailable.set(true);
    expect(p.payment()).toBe('own-key');
    // ... and known to hold no key: the pool.
    p.hasOwnKey.set(false);
    expect(p.payment()).toBe('pool');
    p.builtInCredit.set(true);
    expect(p.payment()).toBe('credit');
    // The pool chosen but switched off: credit, then the own key.
    p.choose('pool');
    expect(p.payment()).toBe('pool');
    p.poolAvailable.set(false);
    expect(p.payment()).toBe('credit');
    p.builtInCredit.set(false);
    expect(p.payment()).toBe('own-key');
    // The own key, once chosen, stays.
    p.poolAvailable.set(true);
    p.choose('own-key');
    expect(p.payment()).toBe('own-key');
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
    // Where credit is sold it stays the default, as before the pool.
    storage.clear();
    const q = create();
    q.builtInCredit.set(true);
    q.poolAvailable.set(true);
    q.hasOwnKey.set(true);
    expect(q.payment()).toBe('credit');
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
