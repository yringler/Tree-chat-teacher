import '@angular/compiler'; // JIT: compiles the components below without the Angular CLI.
import { reflectComponentType } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { App } from './app';
import { PoolPage, poolCreditRequest, type PoolCreditForm } from './pool-page';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

const form = (change: Partial<PoolCreditForm> = {}): PoolCreditForm => ({
  amount: '25',
  userId: '',
  note: '',
  ...change,
});

describe('PoolPage (balance, overage breaker, top-up)', () => {
  const t = templateOf(PoolPage);

  it('is on the admin page', () => {
    expect(reflectComponentType(PoolPage)?.selector).toBe('app-pool-page');
    expect(templateOf(App)).toContain('<app-pool-page />');
  });

  it('shows the balance, holds and the breaker, alerting while it is tripped', () => {
    expect(t).toContain('money(p.availableMicros)');
    expect(t).toContain('money(p.heldMicros)');
    expect(t).toContain('@if (p.breaker.tripped)');
    expect(t).toContain('Overage breaker tripped:');
    expect(t).toContain('money(p.breaker.maxMicros)');
  });

  it('only adjusts the pool: nobody buys pool credit', () => {
    expect(t).not.toContain('simulated_purchase');
    expect(t).not.toMatch(/buyer/i);
  });

  it('builds a pool credit request from the form', () => {
    expect(poolCreditRequest(form({ amount: '$100.5', note: ' Seed ' }), 'key-1')).toEqual({
      target: 'pool',
      userId: null,
      amountCents: 10_050,
      mode: 'adjustment',
      idempotencyKey: 'key-1',
      note: 'Seed',
    });
    expect(poolCreditRequest(form({ amount: '-5.50', userId: ' u1 ' }), 'k')).toMatchObject({
      amountCents: -550,
      userId: 'u1',
    });
    expect(poolCreditRequest(form(), 'k')).not.toHaveProperty('note');
  });

  it('refuses what the server would reject', () => {
    for (const amount of ['', '0', 'ten', '1.234', '--5'])
      expect(typeof poolCreditRequest(form({ amount }), 'k')).toBe('string');
    expect(poolCreditRequest(form({ amount: '500.01' }), 'k')).toBe('At most $500 at a time.');
  });

  it('never says donate or tax-deductible', () => {
    expect(t).not.toMatch(/donat|tax-deductible/i);
  });
});
