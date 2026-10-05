import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import type {
  BillingSummary,
  MembershipInfo,
  MeResponse,
  PoolMeResponse,
  PoolStatusResponse,
} from '@tangent/shared';
import { ApiClient, DEMO_MODE } from '@tangent/web-shared';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore } from './account-store';
import { PaymentStore } from './payment-store';
import { UiStore } from './ui-store';

function membership(overrides: Partial<MembershipInfo> = {}): MembershipInfo {
  return {
    required: true,
    status: 'inactive',
    subscriptionStatus: null,
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
    userId: 'u1',
    accountId: 'u_u1',
    mode: 'simple',
    devMode: false,
    operatorKeys: false,
    builtInCredit: true,
    sharing: false,
    isAdmin: false,
    membership: m,
    featuredConversations: false,
  };
}

const POOL: PoolStatusResponse = {
  enabled: true,
  availableMicros: 2_400_000,
  sessionsRemaining: 120,
  model: { id: 'fast', label: 'Simple' },
  week: { start: '2026-10-05T00:00:00.000Z', exchanges: 3, learners: 2 },
  revenueShareBps: 2000,
};

const POOL_ME: PoolMeResponse = {
  available: true,
  verified: true,
  supporter: false,
  suspended: false,
  caps: {
    requestsPerDay: 30,
    spendMicrosPerDay: 100_000,
    usedRequests: 3,
    usedSpendMicros: 4_000,
    resetAt: '2026-10-06T00:00:00.000Z',
  },
  personalAvailableMicros: 1_000_000,
  consentVersion: 1,
  currentNoticeVersion: 1,
};

function setup(
  billing: () => Promise<BillingSummary>,
  pool: PoolStatusResponse = POOL,
  poolMe: PoolMeResponse = POOL_ME,
) {
  const api = {
    billing: vi.fn(billing),
    poolStatus: vi.fn(async () => pool),
    poolMe: vi.fn(async () => poolMe),
    keyStatus: vi.fn(async () => ({ enabled: true, hasKey: true, providers: ['openrouter'] })),
  };
  const injector = Injector.create({
    providers: [
      { provide: AccountStore },
      { provide: PaymentStore },
      { provide: UiStore },
      { provide: DEMO_MODE, useValue: false },
      { provide: ApiClient, useValue: api },
    ],
  });
  return { account: injector.get(AccountStore), ui: injector.get(UiStore), api };
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

describe('AccountStore community pool', () => {
  it('offers the pool while it is on, and shows its pill while replies run on it', async () => {
    const { account, api } = setup(async () => summary(membership()));
    account.setMe(me(membership({ required: false })));
    await account.refreshPool();
    expect(account.payment.poolAvailable()).toBe(true);
    expect(api.poolMe).toHaveBeenCalled();
    // Credit is chosen (the default) and offered: no pool pill, no model lock.
    expect(account.poolLabel()).toBeNull();
    expect(account.poolModelHint()).toBeNull();
    account.payment.choose('pool');
    expect(account.poolLabel()).toBe('Pool · $2.40');
    expect(account.poolLow()).toBe(false);
    expect(account.poolModel()).toEqual({ id: 'fast', label: 'Simple' });
    expect(account.poolModelHint()).toBe('The community pool uses Simple.');
  });

  it('offers the funding toggle only while both own credit and the pool can pay', async () => {
    const { account } = setup(async () => summary(membership()));
    account.setMe(me(membership({ required: false })));
    expect(account.fundingChoice()).toBe(false);
    await account.refreshPool();
    expect(account.fundingChoice()).toBe(true);
    account.poolMe.set({ ...POOL_ME, personalAvailableMicros: 0 });
    expect(account.fundingChoice()).toBe(false);
  });

  it('hides the funding toggle while replies run on the own key', async () => {
    const { account } = setup(async () => summary(membership()));
    account.setMe(me(membership({ required: false })));
    await account.refreshPool();
    expect(account.fundingChoice()).toBe(true);
    account.payment.choose('own-key');
    expect(account.fundingChoice()).toBe(false);
  });

  it('a saved key with no choice made keeps replies on the key where credit is not sold', async () => {
    const { account } = setup(async () => summary(membership()));
    account.setMe({ ...me(membership({ required: false })), builtInCredit: false });
    await account.refreshPool();
    // Nothing chosen and the key status not known yet: still the key, never the pool.
    expect(account.payment.payment()).toBe('own-key');
    await account.refreshKey();
    expect(account.hasOwnKey()).toBe(true);
    expect(account.payment.payment()).toBe('own-key');
    expect(account.poolLabel()).toBeNull();
    expect(account.poolModel()).toBeNull();
    expect(account.fundingChoice()).toBe(false);
  });

  it("an empty pool, or today's replies used up, turns the pill into a warning", async () => {
    const { account } = setup(async () => summary(membership()), {
      ...POOL,
      availableMicros: 0,
      sessionsRemaining: 0,
    });
    await account.refreshPool();
    expect(account.poolLow()).toBe(true);
    account.poolStatus.set(POOL);
    account.poolMe.set({ ...POOL_ME, caps: { ...POOL_ME.caps, usedRequests: 30 } });
    expect(account.poolLow()).toBe(true);
  });

  it('switching to the pool shows the notice at once when it is not acknowledged yet', async () => {
    const fresh = { ...POOL_ME, consentVersion: null };
    const { account, ui } = setup(async () => summary(membership()), POOL, fresh);
    account.setMe(me(membership({ required: false })));
    account.payment.choose('pool');
    await account.switchToPool();
    expect(ui.poolConsentVersion()).toBe(1);

    // Acknowledged already, or not verified yet (the check comes first): nothing opens.
    for (const poolMe of [POOL_ME, { ...fresh, verified: false }]) {
      const s = setup(async () => summary(membership()), POOL, poolMe);
      s.account.setMe(me(membership({ required: false })));
      s.account.payment.choose('pool');
      await s.account.switchToPool();
      expect(s.ui.poolConsentVersion()).toBeNull();
    }
  });

  it('while the pool is off it is not offered and its caps are not read', async () => {
    const { account, api } = setup(async () => summary(membership()), { ...POOL, enabled: false });
    await account.refreshPool();
    expect(account.payment.poolAvailable()).toBe(false);
    expect(api.poolMe).not.toHaveBeenCalled();
    expect(account.poolMe()).toBeNull();
  });
});
