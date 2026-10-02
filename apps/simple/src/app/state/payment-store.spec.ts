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
    p.paidCredit.set(true);
    // Credit is the default where it is offered.
    expect(p.headers()).toEqual({ 'x-tangent-mode': 'simple', 'x-tangent-payment': 'credit' });
  });

  it('remembers the choice, which applies only while credit is offered', () => {
    const p = create();
    p.paidCredit.set(true);
    p.choose('own-key');
    expect(storage.get('tangent.learn.payment')).toBe('own-key');
    expect(p.payment()).toBe('own-key');

    const again = create();
    again.paidCredit.set(true);
    expect(again.payment()).toBe('own-key');
    again.choose('credit');
    again.paidCredit.set(false);
    expect(again.payment()).toBe('own-key');
  });

  it('the demo always uses its pretend credit', () => {
    storage.set('tangent.learn.payment', 'own-key');
    expect(create(true).payment()).toBe('credit');
  });
});
