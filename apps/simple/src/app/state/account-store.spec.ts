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
    includedCreditCents: 0,
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
    // Where the membership is required, the own key needs it in Learn too.
    membershipNeededFor: m.required ? ['own-key'] : [],
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
  it('shows the gate to a non-member only while replies run on their own key', () => {
    const { account } = setup(async () => summary(membership()));
    expect(account.membershipBlocked()).toBe(false);
    account.setMe(me(membership()));
    // Credit is the default where it is sold, and needs no membership.
    expect(account.payment.payment()).toBe('credit');
    expect(account.membershipBlocked()).toBe(false);
    account.payment.choose('own-key');
    expect(account.membershipBlocked()).toBe(true);
    account.setMe(me(membership({ status: 'active' })));
    expect(account.membershipBlocked()).toBe(false);
    account.setMe(me(membership({ status: 'waived' })));
    expect(account.membershipBlocked()).toBe(false);
    account.setMe(me(membership({ required: false })));
    expect(account.membershipBlocked()).toBe(false);
  });

  it('a redeemed code unblocks and updates the billing summary too', async () => {
    const { account } = setup(async () => summary(membership()));
    account.setMe(me(membership()));
    account.payment.choose('own-key');
    await account.refreshBalance();
    expect(account.membershipBlocked()).toBe(true);
    account.setMembership(membership({ status: 'waived' }));
    expect(account.membershipBlocked()).toBe(false);
    expect(account.billing()?.membership.status).toBe('waived');
  });

  it('a non-member buys and spends credit as anyone does, even with nothing left', async () => {
    const { account } = setup(async () => summary(membership(), 0));
    account.setMe(me(membership()));
    await account.refreshBalance();
    expect(account.payment.member()).toBe(false);
    expect(account.payment.creditUsable()).toBe(true);
    expect(account.payment.payment()).toBe('credit');
    expect(account.creditOnSale()).toBe(true);
    expect(account.membershipBlocked()).toBe(false);
    expect(account.balanceLabel()).toBe('$0.00');
  });

  it('refreshBalance (and the billing page) carry the membership with the balance', async () => {
    const { account } = setup(async () => summary(membership({ status: 'active' }), 3_000_000));
    account.setMe(me(membership()));
    await account.refreshBalance();
    expect(account.payment.payment()).toBe('credit');
    expect(account.balanceLabel()).toBe('$3.00');
    expect(account.creditOnSale()).toBe(true);

    // The membership lapsed: credit, bought or spent, doesn't care.
    account.applyBilling(summary(membership(), 1_000_000));
    expect(account.payment.member()).toBe(false);
    expect(account.membershipBlocked()).toBe(false);
    expect(account.payment.creditUsable()).toBe(true);
    expect(account.payment.payment()).toBe('credit');
    expect(account.balanceText()).toBe('$1.00');
    expect(account.creditOnSale()).toBe(true);

    // Used up where top-ups aren't sold: credit can't pay, and with nothing else on offer the
    // own key needs the membership: the gate shows, with no way out but subscribing.
    account.applyBilling({ ...summary(membership(), 0), topUpsEnabled: false });
    expect(account.payment.creditUsable()).toBe(false);
    expect(account.creditOnSale()).toBe(false);
    expect(account.payment.payment()).toBe('own-key');
    expect(account.membershipBlocked()).toBe(true);
    expect(account.alternativeOffered()).toBeNull();
  });

  it('a non-member with a balance gets the funding toggle; without one, not', async () => {
    const { account } = setup(async () => summary(membership(), 500_000));
    account.setMe(me(membership()));
    await account.refreshPool();
    await account.refreshBalance();
    expect(account.payment.payment()).toBe('credit');
    expect(account.fundingChoice()).toBe(true);
    account.applyBilling(summary(membership(), 0));
    account.poolMe.set({ ...POOL_ME, personalAvailableMicros: 0 });
    expect(account.fundingChoice()).toBe(false);
    // Still on credit: anyone can buy more.
    expect(account.payment.payment()).toBe('credit');
  });

  it('a 402 membership_required blocks at once, then re-reads the real state', async () => {
    const { account, api } = setup(async () => summary(membership({ status: 'inactive' })));
    account.setMe(me(membership({ status: 'active' })));
    account.payment.choose('own-key');
    expect(account.membershipBlocked()).toBe(false);
    account.membershipRequired();
    expect(account.membershipBlocked()).toBe(true);
    await vi.waitFor(() => expect(api.billing).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(account.billing()).not.toBeNull());
    expect(account.membershipBlocked()).toBe(true);
  });

  it('a non-member with a saved key who never picked lands on credit or the pool, not the key', async () => {
    const { account } = setup(async () => summary(membership()));
    account.setMe(me(membership()));
    await account.refreshPool();
    await account.refreshKey();
    expect(account.hasOwnKey()).toBe(true);
    expect(account.payment.payment()).toBe('credit');
    expect(account.membershipBlocked()).toBe(false);
    // Where credit isn't sold: the pool.
    account.setMe({ ...me(membership()), builtInCredit: false });
    expect(account.payment.payment()).toBe('pool');
    expect(account.membershipBlocked()).toBe(false);
  });

  it("the gate's way out moves replies off the own key: to the pool while it is on", async () => {
    const { account } = setup(async () => summary(membership()));
    account.setMe(me(membership()));
    await account.refreshPool();
    account.payment.choose('own-key');
    expect(account.membershipBlocked()).toBe(true);
    expect(account.alternativeOffered()).toBe('Continue on the open pool');
    account.useAlternative();
    expect(account.membershipBlocked()).toBe(false);
    expect(account.payment.payment()).toBe('pool');
  });

  it("the gate's way out moves replies off the own key: to credit while the pool is off", async () => {
    const { account } = setup(async () => summary(membership(), 0), { ...POOL, enabled: false });
    account.setMe(me(membership()));
    await account.refreshPool();
    account.payment.choose('own-key');
    expect(account.membershipBlocked()).toBe(true);
    expect(account.alternativeOffered()).toBe('Continue on Tangent credit');
    account.useAlternative();
    expect(account.membershipBlocked()).toBe(false);
    expect(account.payment.payment()).toBe('credit');
  });

  it('offers no way out when neither the pool nor credit is on', async () => {
    const { account } = setup(async () => summary(membership()), { ...POOL, enabled: false });
    account.setMe({ ...me(membership()), builtInCredit: false });
    await account.refreshPool();
    expect(account.payment.payment()).toBe('own-key');
    expect(account.membershipBlocked()).toBe(true);
    expect(account.alternativeOffered()).toBeNull();
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

describe('AccountStore paidBy', () => {
  it('names credit with its balance, and warns once it is used up', async () => {
    const { account } = setup(async () => summary(membership({ required: false }), 1_200_000));
    account.setMe(me(membership({ required: false })));
    expect(account.paidBy()).toMatchObject({ label: 'Tangent credit', detail: null, warn: false });
    await account.refreshBalance();
    expect(account.paidBy()).toEqual({
      payment: 'credit',
      label: 'Tangent credit',
      short: 'Credit',
      detail: '$1.20 left',
      warn: false,
    });
    account.applyBilling(summary(membership({ required: false }), 0));
    expect(account.paidBy()).toMatchObject({ detail: '$0.00 left', warn: true });
  });

  it('names the own key, and warns while none is saved', async () => {
    const { account, api } = setup(async () => summary(membership()));
    api.keyStatus.mockResolvedValueOnce({ enabled: true, hasKey: false, providers: [] });
    account.payment.choose('own-key');
    await account.refreshKey();
    expect(account.paidBy()).toEqual({
      payment: 'own-key',
      label: 'Your OpenRouter key',
      short: 'Your key',
      detail: 'no key saved',
      warn: true,
    });
    await account.refreshKey();
    expect(account.paidBy()).toMatchObject({ detail: null, warn: false });
  });
});

describe('AccountStore open pool', () => {
  it('offers the pool while it is on, and shows its pill while replies run on it', async () => {
    const { account, api } = setup(async () => summary(membership()));
    account.setMe(me(membership({ required: false })));
    await account.refreshPool();
    expect(account.payment.poolAvailable()).toBe(true);
    expect(api.poolMe).toHaveBeenCalled();
    // Credit is chosen (the default) and offered: no pool pill, no model lock.
    expect(account.paidBy().payment).toBe('credit');
    expect(account.poolModelHint()).toBeNull();
    account.payment.choose('pool');
    expect(account.paidBy()).toEqual({
      payment: 'pool',
      label: 'Open pool',
      short: 'Pool',
      detail: '$2.40 in the pool',
      warn: false,
    });
    expect(account.poolLow()).toBe(false);
    expect(account.poolModel()).toEqual({ id: 'fast', label: 'Simple' });
    expect(account.poolModelHint()).toBe('The open pool uses Simple.');
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
    expect(account.paidBy().label).toBe('Your OpenRouter key');
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
