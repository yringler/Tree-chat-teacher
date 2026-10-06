import '@angular/compiler'; // JIT: compiles the components below without the Angular CLI.
import { describe, expect, it } from 'vitest';
import { UsersPage, userCreditRequest, type UserCreditForm } from './users-page';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

const form = (change: Partial<UserCreditForm> = {}): UserCreditForm => ({
  amount: '25',
  note: '',
  ...change,
});

describe('UsersPage (per-user credit)', () => {
  const t = templateOf(UsersPage);

  it("shows each user's balance with a form to credit them", () => {
    expect(t).toContain('money(u.creditBalanceMicros)');
    expect(t).toContain('(click)="toggleCredit(u)"');
    expect(t).toContain('credit(u)');
  });

  it('only adjusts: it never simulates a purchase', () => {
    expect(t).not.toContain('simulated_purchase');
  });

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

describe('UsersPage (membership)', () => {
  const t = templateOf(UsersPage);

  it('toggles the waiver per user and marks a paid membership', () => {
    expect(t).toContain('[checked]="u.membershipWaived"');
    expect(t).toContain('setMembershipWaived(u, $any($event.target))');
    expect(t).toContain('@if (u.membershipPaid)');
  });
});
