import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import type { BillingSummary, MembershipInfo, MeResponse } from '@tangent/shared';
import { ApiClient, DEMO_MODE } from '@tangent/web-shared';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore } from './account-store';
import { PaymentStore } from './payment-store';

function membership(overrides: Partial<MembershipInfo> = {}): MembershipInfo {
  return {
    required: true,
    status: 'inactive',
    stripeStatus: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
    includedCreditCents: 200,
    ...overrides,
  };
}

function summary(m: MembershipInfo, availableMicros = 2_000_000): BillingSummary {
  return {
    enabled: true,
    membership: m,
    builtInCredit: true,
    currency: 'usd',
    balanceMicros: availableMicros,
    heldMicros: 0,
    availableMicros,
    markupBps: 1000,
    openRouterFeeBps: 550,
    minTopUpCents: 500,
    maxTopUpCents: 50_000,
  };
}

function me(m: MembershipInfo): MeResponse {
  return {
    email: 'learner@example.com',
    accountId: 'u_u1',
    mode: 'simple',
    devMode: false,
    operatorKeys: false,
    builtInCredit: true,
    sharing: false,
    membership: m,
  };
}

function setup(billing: () => Promise<BillingSummary>) {
  const api = { billing: vi.fn(billing) };
  const injector = Injector.create({
    providers: [
      { provide: AccountStore },
      { provide: PaymentStore },
      { provide: DEMO_MODE, useValue: false },
      { provide: ApiClient, useValue: api },
    ],
  });
  return { account: injector.get(AccountStore), api };
}

describe('AccountStore membership', () => {
  it('blocks from /api/me until the membership is active or waived', () => {
    const { account } = setup(async () => summary(membership()));
    expect(account.membershipBlocked()).toBe(false);
    account.setMe(me(membership()));
    expect(account.membershipBlocked()).toBe(true);
    account.setMe(me(membership({ status: 'active' })));
    expect(account.membershipBlocked()).toBe(false);
    account.setMe(me(membership({ required: false })));
    expect(account.membershipBlocked()).toBe(false);
  });

  it('a redeemed code unblocks and updates the billing summary too', async () => {
    const { account } = setup(async () => summary(membership()));
    account.setMe(me(membership()));
    await account.refreshBalance();
    account.setMembership(membership({ status: 'waived' }));
    expect(account.membershipBlocked()).toBe(false);
    expect(account.billing()?.membership.status).toBe('waived');
  });

  it('refreshBalance (and the billing page) carry the membership with the balance', async () => {
    const { account } = setup(async () => summary(membership({ status: 'active' }), 3_000_000));
    account.setMe(me(membership()));
    await account.refreshBalance();
    expect(account.membershipBlocked()).toBe(false);
    expect(account.balanceLabel()).toBe('$3.00');

    account.applyBilling(summary(membership(), 1_000_000));
    expect(account.membershipBlocked()).toBe(true);
    expect(account.balanceLabel()).toBe('$1.00');
  });

  it('a 402 membership_required blocks at once, then re-reads the real state', async () => {
    const { account, api } = setup(async () => summary(membership({ status: 'inactive' })));
    account.setMe(me(membership({ status: 'active' })));
    account.membershipRequired();
    expect(account.membershipBlocked()).toBe(true);
    await vi.waitFor(() => expect(api.billing).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(account.billing()).not.toBeNull());
    expect(account.membershipBlocked()).toBe(true);
  });

  it('keeps the last known state when billing cannot be read', async () => {
    const { account } = setup(async () => Promise.reject(new Error('offline')));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    account.setMe(me(membership({ status: 'waived' })));
    await account.refreshBalance();
    expect(account.membership()?.status).toBe('waived');
    vi.restoreAllMocks();
  });
});
