import '@angular/compiler'; // JIT: @tangent/web-shared, imported here, links its components on load.
import { describe, expect, it } from 'vitest';
import { userCreditRequest, type UserCreditForm } from './users-page';

const form = (change: Partial<UserCreditForm> = {}): UserCreditForm => ({
  amount: '25',
  note: '',
  ...change,
});

describe('UsersPage: the credit request', () => {
  it("builds a request for the user's own ledger", () => {
    expect(
      userCreditRequest(form({ amount: '$10.25', note: ' Goodwill ' }), 'u1', 'key-1'),
    ).toEqual({
      target: 'personal',
      userId: 'u1',
      amountCents: 1025,
      mode: 'adjustment',
      idempotencyKey: 'key-1',
      note: 'Goodwill',
    });
    expect(userCreditRequest(form({ amount: '-5.50' }), 'u1', 'k')).toMatchObject({
      amountCents: -550,
    });
    expect(userCreditRequest(form(), 'u1', 'k')).not.toHaveProperty('note');
  });

  it('refuses what the server would reject', () => {
    for (const amount of ['', '0', 'ten', '1.234', '--5'])
      expect(typeof userCreditRequest(form({ amount }), 'u1', 'k')).toBe('string');
    expect(userCreditRequest(form({ amount: '-500.01' }), 'u1', 'k')).toBe(
      'At most $500 at a time.',
    );
  });
});
