import '@angular/compiler'; // JIT: @tangent/web-shared, imported here, links its components on load.
import { describe, expect, it } from 'vitest';
import { poolCreditRequest, type PoolCreditForm } from './pool-page';

const form = (change: Partial<PoolCreditForm> = {}): PoolCreditForm => ({
  amount: '25',
  userId: '',
  note: '',
  ...change,
});

describe('PoolPage: the top-up request', () => {
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
});
