import '@angular/compiler'; // JIT: @tangent/web-shared, imported here, links its components on load.
import type { AdminWaitlistEntry, AdminWaitlistResponse } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { nextToInvite } from './waitlist-page';

const entry = (email: string, invitedAt: string | null = null): AdminWaitlistEntry => ({
  email,
  createdAt: '2026-10-01T00:00:00.000Z',
  invitedAt,
});

const list = (change: Partial<AdminWaitlistResponse>): AdminWaitlistResponse => ({
  entries: [entry('a@x.org'), entry('b@x.org', '2026-10-02T00:00:00.000Z'), entry('c@x.org')],
  total: 3,
  users: 18,
  maxUsers: 20,
  ...change,
});

describe('WaitlistPage: who "Invite the next" emails', () => {
  it('the oldest not yet invited, as many as there are free places', () => {
    expect(nextToInvite(list({ users: 19 }))).toEqual(['a@x.org']);
    expect(nextToInvite(list({}))).toEqual(['a@x.org', 'c@x.org']);
  });

  it('nobody while full, everyone not invited without a cap', () => {
    expect(nextToInvite(list({ users: 20 }))).toEqual([]);
    expect(nextToInvite(list({ users: 25 }))).toEqual([]);
    expect(nextToInvite(list({ maxUsers: null }))).toEqual(['a@x.org', 'c@x.org']);
  });
});
