import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import type {
  BillingSummary,
  Payer,
  MembershipInfo,
  MeResponse,
  PoolMeResponse,
  PoolStatusResponse,
} from '@tangent/shared';
import {
  API_FETCH,
  ApiClient,
  ComposerController,
  DEMO_MODE,
  ToastStore,
} from '@tangent/web-shared';
import { createDemoFetch } from '@tangent/web-shared/demo';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore } from './account-store';
import { LearnFunding } from './learn-funding';
import { PaymentChoice } from './payment-choice';
import { UiStore } from './ui-store';

/** Each store's injector, for the caller and the learner's pick it holds apart. */
const injectors = new WeakMap<LearnFunding, Injector>();

/** `/api/me` answered: the signed-in caller. */
function signIn(funding: LearnFunding, m: MeResponse): void {
  injectors.get(funding)?.get(AccountStore).me.set(m);
}

/** The learner picks how replies are paid for (remembered, no refresh). */
function pick(funding: LearnFunding, payer: Payer): void {
  injectors.get(funding)?.get(PaymentChoice).choose(payer);
}

function membership(overrides: Partial<MembershipInfo> = {}): MembershipInfo {
  return {
    required: true,
    status: 'inactive',
    subscriptionStatus: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
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
  };
}

const POOL: PoolStatusResponse = {
  enabled: true,
  availableMicros: 2_400_000,
  sessionsRemaining: 120,
  model: { id: 'lite', label: 'Lite' },
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
      { provide: PaymentChoice },
      { provide: LearnFunding },
      { provide: UiStore },
      { provide: ComposerController },
      { provide: ToastStore },
      { provide: DEMO_MODE, useValue: false },
      { provide: ApiClient, useValue: api },
    ],
  });
  const funding = injector.get(LearnFunding);
  injectors.set(funding, injector);
  return { funding, ui: injector.get(UiStore), api };
}

describe('LearnFunding membership', () => {
  it('shows the locked-key notice to a non-member only while replies run on their own key', () => {
    const { funding } = setup(async () => summary(membership()));
    expect(funding.membershipBlocked()).toBe(false);
    signIn(funding, me(membership()));
    // Credit is the default where it is sold, and needs no membership.
    expect(funding.payer()).toBe('credit');
    expect(funding.membershipBlocked()).toBe(false);
    pick(funding, 'own-key');
    expect(funding.membershipBlocked()).toBe(true);
    signIn(funding, me(membership({ status: 'active' })));
    expect(funding.membershipBlocked()).toBe(false);
    signIn(funding, me(membership({ status: 'waived' })));
    expect(funding.membershipBlocked()).toBe(false);
    signIn(funding, me(membership({ required: false })));
    expect(funding.membershipBlocked()).toBe(false);
  });

  it('a redeemed code unblocks and updates the billing summary too', async () => {
    const { funding } = setup(async () => summary(membership()));
    signIn(funding, me(membership()));
    pick(funding, 'own-key');
    await funding.refreshBalance();
    expect(funding.membershipBlocked()).toBe(true);
    funding.setMembership(membership({ status: 'waived' }));
    expect(funding.membershipBlocked()).toBe(false);
    expect(funding.billing()?.membership.status).toBe('waived');
  });

  it('a 402 membership_required locks the own key until the membership is active again', async () => {
    const { funding, api } = setup(async () => summary(membership()));
    signIn(funding, me(membership({ status: 'active' })));
    pick(funding, 'own-key');
    expect(funding.membershipBlocked()).toBe(false);

    // The membership lapsed since /api/me: the server refuses, the billing summary agrees.
    funding.membershipRequired();
    await vi.waitFor(() => expect(api.billing).toHaveBeenCalled());
    expect(funding.membershipBlocked()).toBe(true);

    // A waiver redeemed on the billing page: the own key works again without a reload.
    funding.setMembership(membership({ status: 'waived' }));
    expect(funding.membershipBlocked()).toBe(false);
  });

  it('a non-member buys and spends credit as anyone does, even with nothing left', async () => {
    const { funding } = setup(async () => summary(membership(), 0));
    signIn(funding, me(membership()));
    await funding.refreshBalance();
    expect(funding.member()).toBe(false);
    expect(funding.creditUsable()).toBe(true);
    expect(funding.payer()).toBe('credit');
    expect(funding.creditOnSale()).toBe(true);
    expect(funding.membershipBlocked()).toBe(false);
    expect(funding.balanceLabel()).toBe('$0.00');
  });

  it('refreshBalance (and the billing page) carry the membership with the balance', async () => {
    const { funding } = setup(async () => summary(membership({ status: 'active' }), 3_000_000));
    signIn(funding, me(membership()));
    await funding.refreshBalance();
    expect(funding.payer()).toBe('credit');
    expect(funding.balanceLabel()).toBe('$3.00');
    expect(funding.creditOnSale()).toBe(true);

    // The membership lapsed: credit, bought or spent, doesn't care.
    funding.applyBilling(summary(membership(), 1_000_000));
    expect(funding.member()).toBe(false);
    expect(funding.membershipBlocked()).toBe(false);
    expect(funding.creditUsable()).toBe(true);
    expect(funding.payer()).toBe('credit');
    expect(funding.balanceText()).toBe('$1.00');
    expect(funding.creditOnSale()).toBe(true);

    // Used up where top-ups aren't sold: credit can't pay, and with nothing else on offer the
    // own key needs the membership: the locked-key notice offers only subscribing.
    funding.applyBilling({ ...summary(membership(), 0), topUpsEnabled: false });
    expect(funding.creditUsable()).toBe(false);
    expect(funding.creditOnSale()).toBe(false);
    expect(funding.payer()).toBe('own-key');
    expect(funding.membershipBlocked()).toBe(true);
    expect(funding.keyLockedWays()).toEqual({ pool: false, credit: false });
  });

  it('a non-member with a balance gets the funding toggle; without one, not', async () => {
    const { funding } = setup(async () => summary(membership(), 500_000));
    signIn(funding, me(membership()));
    await funding.refreshPool();
    // fundingChoice is false before billing loads: the toggle waits for the balance the
    // default payment goes by, even where the pool's own read already names one.
    expect(funding.billing()).toBeNull();
    expect(funding.fundingChoice()).toBe(false);
    await funding.refreshBalance();
    expect(funding.payer()).toBe('credit');
    expect(funding.fundingChoice()).toBe(true);
    funding.applyBilling(summary(membership(), 0));
    funding.poolMe.set({ ...POOL_ME, personalAvailableMicros: 0 });
    expect(funding.fundingChoice()).toBe(false);
    // Nothing left: the pool, which is on, replies right away (credit stays on sale).
    expect(funding.payer()).toBe('pool');
    expect(funding.creditOnSale()).toBe(true);
    expect(funding.membershipBlocked()).toBe(false);
  });

  it('a 402 membership_required received while paying with credit leaves payment on credit', async () => {
    const { funding, api } = setup(async () => summary(membership(), 1_000_000));
    signIn(funding, me(membership({ status: 'active' })));
    pick(funding, 'credit');
    expect(funding.payer()).toBe('credit');
    // The server only refuses own-key calls so; one that arrives once replies run on credit
    // (the default moved while it was in flight) locks nothing here.
    funding.membershipRequired();
    expect(funding.payer()).toBe('credit');
    expect(funding.membershipBlocked()).toBe(false);
    expect(funding.paidBy()).toMatchObject({ payer: 'credit', label: 'Tangent credit' });
    expect(funding.paidBy().detail).not.toBe('needs a membership');
    await vi.waitFor(() => expect(api.billing).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(funding.billing()).not.toBeNull());
    expect(funding.payer()).toBe('credit');
    expect(funding.membershipBlocked()).toBe(false);
    // Back on the own key, the refusal (and the membership re-read) locks it.
    pick(funding, 'own-key');
    expect(funding.membershipBlocked()).toBe(true);
  });

  it('a 402 membership_required blocks at once, then re-reads the real state', async () => {
    const { funding, api } = setup(async () => summary(membership({ status: 'inactive' })));
    signIn(funding, me(membership({ status: 'active' })));
    pick(funding, 'own-key');
    expect(funding.membershipBlocked()).toBe(false);
    funding.membershipRequired();
    expect(funding.membershipBlocked()).toBe(true);
    await vi.waitFor(() => expect(api.billing).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(funding.billing()).not.toBeNull());
    expect(funding.membershipBlocked()).toBe(true);
  });

  it('a non-member with a saved key who never picked lands on credit or the pool, not the key', async () => {
    const { funding } = setup(async () => summary(membership()));
    signIn(funding, me(membership()));
    await funding.refreshPool();
    await funding.refreshKey();
    expect(funding.hasOwnKey()).toBe(true);
    expect(funding.payer()).toBe('credit');
    expect(funding.membershipBlocked()).toBe(false);
    // Where credit isn't sold: the pool.
    signIn(funding, { ...me(membership()), builtInCredit: false });
    expect(funding.payer()).toBe('pool');
    expect(funding.membershipBlocked()).toBe(false);
  });

  it('a locked own key offers both ways out, and either one unlocks the composer', async () => {
    const { funding } = setup(async () => summary(membership(), 0));
    signIn(funding, me(membership()));
    await funding.refreshPool();
    pick(funding, 'own-key');
    expect(funding.membershipBlocked()).toBe(true);
    // Credit with a zero balance still counts: anyone can buy it.
    expect(funding.keyLockedWays()).toEqual({ pool: true, credit: true });
    funding.switchTo('pool');
    expect(funding.membershipBlocked()).toBe(false);
    expect(funding.payer()).toBe('pool');

    pick(funding, 'own-key');
    expect(funding.membershipBlocked()).toBe(true);
    funding.switchTo('credit');
    expect(funding.membershipBlocked()).toBe(false);
    expect(funding.payer()).toBe('credit');
  });

  it('a lapsed member whose browser still chose the own key is locked; renewing unlocks it', async () => {
    const lapsed = membership({ subscriptionStatus: 'canceled' });
    const { funding } = setup(async () => summary(lapsed));
    signIn(funding, me(lapsed));
    await funding.refreshPool();
    pick(funding, 'own-key');
    expect(funding.payer()).toBe('own-key');
    expect(funding.membershipBlocked()).toBe(true);
    funding.setMembership(membership({ status: 'active', subscriptionStatus: 'active' }));
    expect(funding.membershipBlocked()).toBe(false);
    expect(funding.payer()).toBe('own-key');
  });

  it('offers only the membership when neither the pool nor credit is on', async () => {
    const { funding } = setup(async () => summary(membership()), { ...POOL, enabled: false });
    signIn(funding, { ...me(membership()), builtInCredit: false });
    await funding.refreshPool();
    expect(funding.payer()).toBe('own-key');
    expect(funding.membershipBlocked()).toBe(true);
    expect(funding.keyLockedWays()).toEqual({ pool: false, credit: false });
  });

  it('with the fee off (or keys the server cannot store) the own key is open to everyone', async () => {
    const off = membership({ required: false });
    const { funding } = setup(async () => summary(off, 0), { ...POOL, enabled: false });
    signIn(funding, me(off));
    await funding.refreshPool();
    await funding.refreshKey();
    await funding.refreshBalance();
    expect(funding.member()).toBe(true);
    // A saved key, no balance: replies run on the key, which nothing locks.
    expect(funding.payer()).toBe('own-key');
    expect(funding.membershipBlocked()).toBe(false);
    expect(funding.paidBy()).toEqual({
      payer: 'own-key',
      label: 'Your OpenRouter key',
      short: 'Your key',
      detail: null,
      warn: false,
    });
    // Chosen explicitly, too.
    pick(funding, 'own-key');
    expect(funding.membershipBlocked()).toBe(false);
    expect(funding.paidBy().detail).not.toBe('needs a membership');
  });

  it('a billing summary that cannot be read defaults nothing to locked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A non-member, credit sold, the pool off: credit (anyone can buy it), not the locked key.
    const s = setup(async () => Promise.reject(new Error('offline')), { ...POOL, enabled: false });
    signIn(s.funding, me(membership()));
    await s.funding.refreshPool();
    await s.funding.refreshKey();
    await s.funding.refreshBalance();
    expect(s.funding.billing()).toBeNull();
    expect(s.funding.payer()).toBe('credit');
    expect(s.funding.membershipBlocked()).toBe(false);
    // The pool on: credit still, which the server moves to the pool if it can't pay.
    const t = setup(async () => Promise.reject(new Error('offline')));
    signIn(t.funding, me(membership()));
    await t.funding.refreshPool();
    await t.funding.refreshBalance();
    expect(t.funding.payer()).toBe('credit');
    expect(t.funding.membershipBlocked()).toBe(false);
    expect(t.funding.fundingChoice()).toBe(false);
    // A member keeps their key, unlocked.
    const u = setup(async () => Promise.reject(new Error('offline')));
    signIn(u.funding, me(membership({ status: 'active' })));
    await u.funding.refreshKey();
    await u.funding.refreshBalance();
    expect(u.funding.payer()).toBe('own-key');
    expect(u.funding.membershipBlocked()).toBe(false);
    vi.restoreAllMocks();
  });

  it('keeps the last known state when billing cannot be read', async () => {
    const { funding } = setup(async () => Promise.reject(new Error('offline')));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    signIn(funding, me(membership({ status: 'waived' })));
    await funding.refreshBalance();
    expect(funding.membership()?.status).toBe('waived');
    vi.restoreAllMocks();
  });
});

describe('LearnFunding paidBy', () => {
  it('names credit with its balance, and warns once it is used up', async () => {
    const { funding, api } = setup(async () => summary(membership({ required: false }), 1_200_000));
    api.keyStatus.mockResolvedValueOnce({ enabled: true, hasKey: false, providers: [] });
    signIn(funding, me(membership({ required: false })));
    // No key saved and the pool not on: credit, which can be bought, before the balance is read.
    await funding.refreshKey();
    expect(funding.paidBy()).toMatchObject({ label: 'Tangent credit', detail: null, warn: false });
    await funding.refreshBalance();
    expect(funding.paidBy()).toEqual({
      payer: 'credit',
      label: 'Tangent credit',
      short: 'Credit',
      detail: '$1.20 left',
      warn: false,
    });
    funding.applyBilling(summary(membership({ required: false }), 0));
    expect(funding.paidBy()).toMatchObject({ detail: '$0.00 left', warn: true });
  });

  it('names the own key, and warns while none is saved', async () => {
    const { funding, api } = setup(async () => summary(membership()));
    api.keyStatus.mockResolvedValueOnce({ enabled: true, hasKey: false, providers: [] });
    pick(funding, 'own-key');
    await funding.refreshKey();
    expect(funding.paidBy()).toEqual({
      payer: 'own-key',
      label: 'Your OpenRouter key',
      short: 'Your key',
      detail: 'no key saved',
      warn: true,
    });
    await funding.refreshKey();
    expect(funding.paidBy()).toMatchObject({ detail: null, warn: false });
  });

  it('a locked own key asks for the membership, not for a key', async () => {
    const { funding, api } = setup(async () => summary(membership()));
    signIn(funding, me(membership()));
    api.keyStatus.mockResolvedValueOnce({ enabled: true, hasKey: false, providers: [] });
    pick(funding, 'own-key');
    await funding.refreshKey();
    expect(funding.membershipBlocked()).toBe(true);
    expect(funding.needsKey()).toBe(false);
    expect(funding.paidBy()).toMatchObject({ detail: 'needs a membership', warn: true });
  });
});

describe('LearnFunding open pool', () => {
  it('offers the pool while it is on, and shows its pill while replies run on it', async () => {
    const { funding, api } = setup(async () => summary(membership()));
    signIn(funding, me(membership({ required: false })));
    await funding.refreshPool();
    await funding.refreshBalance();
    expect(funding.poolOn()).toBe(true);
    expect(api.poolMe).toHaveBeenCalled();
    // Credit with a balance is the default: no pool pill, no model lock.
    expect(funding.paidBy().payer).toBe('credit');
    expect(funding.poolModelHint()).toBeNull();
    pick(funding, 'pool');
    expect(funding.paidBy()).toEqual({
      payer: 'pool',
      label: 'Open pool',
      short: 'Pool',
      detail: '$2.40 in the pool',
      warn: false,
    });
    expect(funding.poolLow()).toBe(false);
    expect(funding.poolModel()).toEqual({ id: 'lite', label: 'Lite' });
    expect(funding.poolModelHint()).toBe('The open pool uses Lite.');
  });

  it("names how the pool asks a tier's model when it asks it differently", async () => {
    const pool: PoolStatusResponse = {
      ...POOL,
      model: { id: 'n', label: 'Normal', thinking: 'lighter', replies: 'shorter' },
    };
    const { funding } = setup(async () => summary(membership()), pool);
    signIn(funding, me(membership({ required: false })));
    await funding.refreshPool();
    pick(funding, 'pool');
    expect(funding.poolModelHint()).toBe(
      "The open pool uses Normal's model with lighter thinking and shorter replies.",
    );
  });

  it('offers the funding toggle only while both own credit and the pool can pay', async () => {
    const { funding } = setup(async () => summary(membership()));
    signIn(funding, me(membership({ required: false })));
    expect(funding.fundingChoice()).toBe(false);
    await funding.refreshPool();
    // Not before the billing summary is read.
    expect(funding.fundingChoice()).toBe(false);
    await funding.refreshBalance();
    expect(funding.fundingChoice()).toBe(true);
    funding.poolMe.set({ ...POOL_ME, personalAvailableMicros: 0 });
    expect(funding.fundingChoice()).toBe(false);
  });

  it('hides the funding toggle while replies run on the own key', async () => {
    const { funding } = setup(async () => summary(membership()));
    signIn(funding, me(membership({ required: false })));
    await funding.refreshPool();
    await funding.refreshBalance();
    expect(funding.fundingChoice()).toBe(true);
    pick(funding, 'own-key');
    expect(funding.fundingChoice()).toBe(false);
  });

  it('a saved key with no choice made keeps replies on the key where credit is not sold', async () => {
    const { funding } = setup(async () => summary(membership()));
    signIn(funding, { ...me(membership({ required: false })), builtInCredit: false });
    await funding.refreshPool();
    // Nothing chosen and the key status not known yet: still the key, never the pool.
    expect(funding.payer()).toBe('own-key');
    await funding.refreshKey();
    expect(funding.hasOwnKey()).toBe(true);
    expect(funding.payer()).toBe('own-key');
    expect(funding.paidBy().label).toBe('Your OpenRouter key');
    expect(funding.poolModel()).toBeNull();
    expect(funding.fundingChoice()).toBe(false);
  });

  it("an empty pool, or today's replies used up, turns the pill into a warning", async () => {
    const { funding } = setup(async () => summary(membership()), {
      ...POOL,
      availableMicros: 0,
      sessionsRemaining: 0,
    });
    await funding.refreshPool();
    expect(funding.poolLow()).toBe(true);
    funding.poolStatus.set(POOL);
    funding.poolMe.set({ ...POOL_ME, caps: { ...POOL_ME.caps, usedRequests: 30 } });
    expect(funding.poolLow()).toBe(true);
  });

  it('while the pool is off it is not offered and its caps are not read', async () => {
    const { funding, api } = setup(async () => summary(membership()), { ...POOL, enabled: false });
    await funding.refreshPool();
    expect(funding.poolOn()).toBe(false);
    expect(api.poolMe).not.toHaveBeenCalled();
    expect(funding.poolMe()).toBeNull();
  });
});

describe('LearnFunding in the demo', () => {
  it("the demo backend's data offers no membership lock, pool, funding toggle or top-ups", async () => {
    const injector = Injector.create({
      providers: [
        { provide: AccountStore },
        { provide: PaymentChoice },
        { provide: LearnFunding },
        { provide: UiStore },
        { provide: ComposerController },
        { provide: ToastStore },
        { provide: ApiClient },
        { provide: DEMO_MODE, useValue: true },
        { provide: API_FETCH, useValue: createDemoFetch({ mode: 'simple', storage: null }) },
      ],
    });
    const funding = injector.get(LearnFunding);
    injectors.set(funding, injector);
    const api = injector.get(ApiClient);
    signIn(funding, await api.me());
    await funding.refreshBalance();
    await funding.refreshPool();

    expect(funding.payer()).toBe('credit');
    expect(funding.membershipBlocked()).toBe(false);
    expect(funding.poolOn()).toBe(false);
    expect(funding.poolMe()).toBeNull();
    expect(funding.fundingChoice()).toBe(false);
    expect(funding.creditOnSale()).toBe(false);
  });
});

describe('LearnFunding switchTo', () => {
  it('remembers the pick, reads the new payer, and lets the open lesson take it up', async () => {
    const { funding, api } = setup(async () => summary(membership({ status: 'active' })));
    signIn(funding, me(membership({ status: 'active' })));
    const hook = vi.fn(() => true);
    funding.whenSwitched(hook);
    expect(funding.switchTo('pool')).toBe(true);
    expect(hook).toHaveBeenCalledWith('pool');
    await vi.waitFor(() => expect(funding.poolOn()).toBe(true));
    expect(funding.payer()).toBe('pool');
    expect(api.billing).not.toHaveBeenCalled();
    funding.switchTo('credit');
    await vi.waitFor(() => expect(api.billing).toHaveBeenCalledTimes(1));
    expect(funding.payer()).toBe('credit');
  });

  it('a way off the locked own key unlocks it, wherever it was picked', async () => {
    const { funding } = setup(async () => summary(membership({ status: 'active' })));
    signIn(funding, me(membership({ status: 'active' })));
    pick(funding, 'own-key');
    funding.membershipRequired();
    expect(funding.membershipBlocked()).toBe(true);
    funding.switchTo('credit');
    // Back on the own key, the real membership decides again (active here).
    pick(funding, 'own-key');
    await vi.waitFor(() => expect(funding.billing()).not.toBeNull());
    expect(funding.membershipBlocked()).toBe(false);
  });
});

describe('LearnFunding paid-by pill', () => {
  it('shows the payer the server used while replies are asked for the same way', async () => {
    const { funding } = setup(async () => summary(membership({ status: 'active' }), 100));
    signIn(funding, me(membership({ status: 'active' })));
    await funding.refreshBalance();
    await funding.refreshPool();
    expect(funding.payer()).toBe('credit');
    // The server moved the reply to the pool (the credit couldn't cover a call's hold).
    funding.paidWith('pool');
    expect(funding.paidBy()).toMatchObject({ payer: 'pool', short: 'Pool' });
    // Asked another way now: the pill says what will be asked for.
    pick(funding, 'own-key');
    expect(funding.paidBy().payer).toBe('own-key');
  });

  it('names the payer every call asks for in the headers', () => {
    const injector = Injector.create({
      providers: [
        { provide: AccountStore },
        { provide: PaymentChoice },
        { provide: LearnFunding },
        { provide: DEMO_MODE, useValue: false },
        { provide: ApiClient, useValue: {} },
      ],
    });
    const funding = injector.get(LearnFunding);
    const choice = injector.get(PaymentChoice);
    expect(choice.headers()).toEqual({
      'x-tangent-mode': 'simple',
      'x-tangent-payment': 'own-key',
    });
    injector.get(AccountStore).me.set(me(membership({ status: 'active' })));
    choice.choose('credit');
    expect(funding.payer()).toBe('credit');
    expect(choice.headers()).toEqual({ 'x-tangent-mode': 'simple', 'x-tangent-payment': 'credit' });
  });

  it('forgets what the server said once a fact changes: a top-up, the pool, a new pick', async () => {
    const { funding } = setup(async () => summary(membership({ status: 'active' }), 100));
    signIn(funding, me(membership({ status: 'active' })));
    await funding.refreshBalance();
    funding.paidWith('pool');
    expect(funding.paidBy().payer).toBe('pool');
    // A top-up: credit can pay again, and the pill says so.
    funding.applyBilling(summary(membership({ status: 'active' }), 5_000_000));
    expect(funding.paidBy().payer).toBe('credit');
    funding.paidWith('pool');
    await funding.refreshPool();
    expect(funding.paidBy().payer).toBe('credit');
    funding.paidWith('pool');
    funding.switchTo('credit');
    expect(funding.paidBy().payer).toBe('credit');
  });
});

describe('LearnFunding: credit picked but unable to pay', () => {
  it('keeps the pick on credit while replies use the pool, and says so', async () => {
    const { funding } = setup(async () => summary(membership(), 0));
    signIn(funding, me(membership()));
    await funding.refreshBalance();
    await funding.refreshPool();
    pick(funding, 'credit');
    expect(funding.payer()).toBe('pool');
    expect(funding.picked()).toBe('credit');
    expect(funding.creditWaiting()).toBe(true);
    // Credit that can pay: nothing is waiting.
    funding.applyBilling(summary(membership(), 1_000_000));
    expect(funding.payer()).toBe('credit');
    expect(funding.creditWaiting()).toBe(false);
  });

  it('says when picking credit would reply on the pool, so the locked key asks for credit first', async () => {
    const { funding } = setup(async () => summary(membership(), 0));
    signIn(funding, me(membership()));
    expect(funding.creditWouldWait()).toBe(false); // nothing known yet
    await funding.refreshBalance();
    await funding.refreshPool();
    expect(funding.creditWouldWait()).toBe(true);
    funding.applyBilling(summary(membership(), 1_000_000));
    expect(funding.creditWouldWait()).toBe(false);
  });

  it('a pick that applies is the pick; none yet shows the payer', async () => {
    const { funding } = setup(async () => summary(membership(), 0));
    signIn(funding, me(membership()));
    await funding.refreshPool();
    expect(funding.picked()).toBe(funding.payer());
    pick(funding, 'pool');
    expect(funding.picked()).toBe('pool');
  });
});

describe('LearnFunding membership refusals', () => {
  it('a way off the own key lifts a refusal at once, without waiting for the billing summary', () => {
    const { funding } = setup(() => new Promise<BillingSummary>(() => undefined));
    pick(funding, 'own-key');
    // No membership known yet: the refusal alone locks the key.
    funding.membershipRequired();
    expect(funding.membershipBlocked()).toBe(true);
    funding.switchTo('pool');
    pick(funding, 'own-key');
    expect(funding.membershipBlocked()).toBe(false);
  });

  it('a fresh /api/me outranks an earlier refusal, as a renewed membership does', () => {
    const { funding } = setup(() => new Promise<BillingSummary>(() => undefined));
    pick(funding, 'own-key');
    funding.membershipRequired();
    expect(funding.membershipBlocked()).toBe(true);
    signIn(funding, me(membership({ status: 'active' })));
    expect(funding.membershipBlocked()).toBe(false);
  });
});

describe('LearnFunding in the demo, and the remembered pick', () => {
  it('the demo always runs on its pretend credit, whatever was picked', () => {
    const injector = Injector.create({
      providers: [
        { provide: AccountStore },
        { provide: PaymentChoice },
        { provide: LearnFunding },
        { provide: DEMO_MODE, useValue: true },
        { provide: ApiClient, useValue: {} },
      ],
    });
    injector.get(PaymentChoice).choose('own-key');
    expect(injector.get(LearnFunding).payer()).toBe('credit');
    expect(injector.get(PaymentChoice).headers()['x-tangent-payment']).toBe('credit');
  });

  it('remembers each pick in this browser, and ignores anything unknown', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    });
    try {
      for (const payer of ['own-key', 'credit', 'pool'] as const) {
        new PaymentChoice().choose(payer);
        expect(storage.get('tangent.learn.payment')).toBe(payer);
        expect(new PaymentChoice().chosen()).toBe(payer);
      }
      storage.set('tangent.learn.payment', 'free');
      expect(new PaymentChoice().chosen()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
