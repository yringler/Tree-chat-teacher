import type {
  BillingSummary,
  KeyStatusResponse,
  MeResponse,
  MembershipInfo,
  PoolStatusResponse,
  ProviderInfo,
} from '@tangent/shared';
import { providerRouteKey } from '@tangent/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../core/api-client';
import { PowerAccountStore } from './power-account';

function membership(over: Partial<MembershipInfo> = {}): MembershipInfo {
  return {
    required: true,
    status: 'active',
    subscriptionStatus: 'active',
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
    ...over,
  };
}

const inactive = (over: Partial<MembershipInfo> = {}) =>
  membership({ status: 'inactive', subscriptionStatus: 'canceled', ...over });

function me(over: Partial<MeResponse> = {}): MeResponse {
  return {
    email: 'a@example.com',
    userId: '1',
    accountId: 'p_1',
    mode: 'power',
    devMode: false,
    operatorKeys: false,
    builtInCredit: true,
    sharing: true,
    isAdmin: false,
    membership: membership(),
    membershipNeededFor: ['own-key'],
    ...over,
  };
}

const summary = { availableMicros: 2_500_000 } as BillingSummary;
/** An empty balance where top-ups are sold: anyone can buy more. */
const empty = { availableMicros: 0, topUpsEnabled: true } as BillingSummary;
/** An empty balance where top-ups aren't sold: credit can't pay. */
const spent = { availableMicros: 0, topUpsEnabled: false } as BillingSummary;

/** The user's OpenRouter, with a key saved. */
const ownKey: ProviderInfo = {
  id: 'openrouter',
  kind: 'openai-compatible',
  label: 'OpenRouter',
  models: [{ id: 'a/b', label: 'A' }],
  defaultModel: 'a/b',
  openModels: true,
  available: true,
  acceptsUserKey: true,
  keySource: 'user',
  funding: 'own-key',
};
const credit: ProviderInfo = {
  ...ownKey,
  label: 'Tangent credit',
  models: [{ id: 'max/model', label: 'Max' }],
  defaultModel: 'max/model',
  acceptsUserKey: false,
  keySource: 'server',
  funding: 'credit',
};

function setup(providers: ProviderInfo[] = [ownKey, credit]) {
  const api = {
    me: vi.fn(async (): Promise<MeResponse> => me()),
    providers: vi.fn(async (): Promise<ProviderInfo[]> => providers),
    keyStatus: vi.fn(async (): Promise<KeyStatusResponse> => ({
      enabled: true,
      hasKey: false,
      providers: [],
    })),
    saveKey: vi.fn(async (_provider: string, _key: string) => undefined),
    forgetKey: vi.fn(async (_provider?: string) => undefined),
    billing: vi.fn(async (): Promise<BillingSummary> => summary),
    poolStatus: vi.fn(async () => ({ enabled: false }) as PoolStatusResponse),
  };
  const errors: unknown[] = [];
  const account = new PowerAccountStore(api, (err) => errors.push(err));
  return { account, api, errors };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('PowerAccountStore reading the account', () => {
  it('keeps the membership and what needs it from me; reads the balance wherever credit is offered', async () => {
    const s = setup();
    await s.account.init(me({ builtInCredit: false }));
    expect(s.account.membership()?.status).toBe('active');
    expect(s.account.membershipNeededFor()).toEqual(['own-key']);
    expect([...s.account.lockedFundings()]).toEqual([]);
    expect(s.api.billing).not.toHaveBeenCalled();
    expect(s.api.keyStatus).toHaveBeenCalledTimes(1);
    expect(s.api.poolStatus).toHaveBeenCalledTimes(1);
    expect(s.account.providersLoaded()).toBe(true);

    // A member too: the default route of a new conversation needs the balance.
    await s.account.init(me());
    expect(s.api.billing).toHaveBeenCalledTimes(1);

    await s.account.init(me({ membership: inactive() }));
    expect(s.api.billing).toHaveBeenCalledTimes(2);
    expect(s.account.creditCarriesOn()).toBe(true);
    expect([...s.account.lockedFundings()]).toEqual(['own-key']);
  });

  it('the balance and the pool keep quiet when they cannot be read', async () => {
    const s = setup();
    s.api.billing.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    s.api.poolStatus.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    await s.account.init(me());
    expect(s.account.billing()).toBeNull();
    expect(s.account.poolOn()).toBe(false);
    expect(s.errors).toEqual([]);
    await s.account.refreshBilling();
    expect(s.account.billing()).toBe(summary);
  });

  it('a key status or provider list that cannot be read goes to the error policy', async () => {
    const s = setup();
    const refused = new ApiError(500, 'internal', 'boom');
    s.api.providers.mockRejectedValueOnce(refused);
    await s.account.refreshKeys();
    expect(s.errors).toEqual([refused]);
    // Read once all the same: nothing is known to be unable to generate.
    expect(s.account.providersLoaded()).toBe(true);
  });

  it('saving or forgetting a key reads the keys again, and reports a refusal', async () => {
    const s = setup();
    await expect(s.account.saveKey('openrouter', 'sk-1')).resolves.toBe(true);
    expect(s.api.saveKey).toHaveBeenCalledWith('openrouter', 'sk-1');
    expect(s.api.providers).toHaveBeenCalledTimes(1);
    const refused = new ApiError(400, 'bad_request', 'Not a key');
    s.api.saveKey.mockRejectedValueOnce(refused);
    await expect(s.account.saveKey('openrouter', 'nope')).resolves.toBe(false);
    expect(s.errors).toEqual([refused]);
    expect(s.api.providers).toHaveBeenCalledTimes(2);
    await s.account.forgetKey('openrouter');
    expect(s.api.forgetKey).toHaveBeenCalledWith('openrouter');
    expect(s.api.providers).toHaveBeenCalledTimes(3);
  });

  it('a summary from the billing page (a renewal or a code) brings the membership with it', async () => {
    const s = setup();
    await s.account.init(me({ membership: inactive() }));
    expect([...s.account.lockedFundings()]).toEqual(['own-key']);
    s.account.applyBilling({ ...summary, membership: membership({ status: 'waived' }) });
    expect([...s.account.lockedFundings()]).toEqual([]);
    expect(s.account.billing()?.availableMicros).toBe(2_500_000);
  });

  it('tells the built-in endpoint on the user key from Tangent credit', () => {
    const s = setup();
    s.account.providers.set([ownKey, credit]);
    expect(s.account.providerOf({ providerId: 'openrouter' })?.label).toBe('OpenRouter');
    expect(s.account.providerOf({ providerId: 'openrouter', funding: 'credit' })?.label).toBe(
      'Tangent credit',
    );
    expect(s.account.providerOf({ providerId: 'other' })).toBeUndefined();
  });
});

describe('PowerAccountStore entitlements without a membership', () => {
  it('a member has nothing locked, and generates on every route', async () => {
    const s = setup();
    await s.account.init(me());
    expect([...s.account.lockedFundings()]).toEqual([]);
    expect(s.account.openRoutes()).toEqual([ownKey, credit]);
    expect(s.account.canGenerate()).toBe(true);
    expect(s.account.routeState({ providerId: 'openrouter', funding: 'own-key' })).toBe('open');
  });

  it('only the membership hides anything: not a missing key, nor a provider list not read yet', async () => {
    const s = setup([{ ...ownKey, available: false }]);
    expect(s.account.canGenerate()).toBe(true);
    await s.account.init(me());
    expect(s.account.openRoutes()).toEqual([]);
    expect(s.account.canGenerate()).toBe(true);

    const t = setup();
    t.api.billing.mockResolvedValue(spent);
    t.account.membership.set(inactive());
    t.account.membershipNeededFor.set(['own-key']);
    expect(t.account.canGenerate()).toBe(true); // providers not read yet
    await t.account.refreshKeys();
    expect(t.account.canGenerate()).toBe(false);
  });

  it('own keys lock; Tangent credit carries on while it can pay', async () => {
    const s = setup();
    await s.account.init(me({ membership: inactive() }));
    expect(s.account.routeLocked({ funding: 'own-key' })).toBe(true);
    expect(s.account.routeLocked({})).toBe(true);
    expect(s.account.routeLocked({ funding: 'credit' })).toBe(false);
    expect(s.account.openRoutes()).toEqual([credit]);
    expect(s.account.canGenerate()).toBe(true);
    expect(s.account.creditRoute()).toBe(credit);
    expect(s.account.defaultProvider()).toBe(credit);
  });

  it('with an empty balance, credit carries on where top-ups are sold (they can buy)', async () => {
    const s = setup();
    s.api.billing.mockResolvedValue(empty);
    await s.account.init(me({ membership: inactive({ subscriptionStatus: null }) }));
    expect(s.account.creditCarriesOn()).toBe(true);
    expect(s.account.openRoutes()).toEqual([credit]);
    expect(s.account.creditRoute()).toBe(credit);
    // Credit, which can be bought, beats an own key the membership locks.
    expect(s.account.defaultProvider()).toBe(credit);
  });

  it('where credit can be neither bought nor spent, nothing can generate', async () => {
    const s = setup();
    s.api.billing.mockResolvedValue(spent);
    await s.account.init(me({ membership: inactive() }));
    expect(s.account.openRoutes()).toEqual([]);
    expect(s.account.canGenerate()).toBe(false);
    expect(s.account.creditRoute()).toBeNull();
  });

  it('offers a copy in Learn only where Learn can reply: on the pool while it is on, else on credit', async () => {
    const s = setup();
    await s.account.init(me({ membership: inactive() }));
    expect(s.account.poolOn()).toBe(false);
    expect(s.account.learnCopyWay()).toBe('credit');

    const pool = setup();
    pool.api.poolStatus.mockResolvedValue({ enabled: true } as PoolStatusResponse);
    await pool.account.init(me({ membership: inactive() }));
    expect(pool.account.poolOn()).toBe(true);
    expect(pool.account.learnCopyWay()).toBe('pool');

    // Neither the pool nor credit that can pay or be bought: no copy (it could only be read).
    const stuck = setup();
    stuck.api.billing.mockResolvedValue(spent);
    await stuck.account.init(me({ membership: inactive() }));
    expect(stuck.account.learnCopyWay()).toBeNull();
    // Nor where credit isn't offered at all, or the pool status can't be read.
    const none = setup();
    none.api.poolStatus.mockRejectedValue(new ApiError(500, 'internal', 'boom'));
    await none.account.init(me({ membership: inactive(), builtInCredit: false }));
    expect(none.account.poolOn()).toBe(false);
    expect(none.account.learnCopyWay()).toBeNull();
  });

  it('nothing locks where no membership is required (the fee off, a server without billing)', async () => {
    const s = setup();
    await s.account.init(
      me({
        membership: membership({ required: false, status: 'inactive', subscriptionStatus: null }),
        membershipNeededFor: [],
      }),
    );
    expect([...s.account.lockedFundings()]).toEqual([]);
    expect(s.account.canGenerate()).toBe(true);
    // Whatever a stale list said: without a requirement nothing is locked.
    s.account.membershipNeededFor.set(['own-key']);
    expect([...s.account.lockedFundings()]).toEqual([]);
  });
});

describe('PowerAccountStore routeState', () => {
  const noKey: ProviderInfo = { ...ownKey, available: false, keySource: null };

  it('is open, locked by the membership, or waiting for the user’s own key', async () => {
    const s = setup([noKey, credit]);
    await s.account.init(me());
    expect(s.account.routeState({ providerId: 'openrouter', funding: 'credit' })).toBe('open');
    expect(s.account.routeState({ providerId: 'openrouter', funding: 'own-key' })).toBe(
      'key-missing',
    );
    expect(s.account.keyMissing({ providerId: 'openrouter' })).toBe(true);
    // A route the list doesn't know is not waiting for a key.
    expect(s.account.routeState({ providerId: 'gone', funding: 'own-key' })).toBe('open');
  });

  it('the membership comes first: a locked route with no key is locked', async () => {
    const s = setup([noKey, credit]);
    await s.account.init(me({ membership: inactive() }));
    expect(s.account.routeState({ providerId: 'openrouter', funding: 'own-key' })).toBe('locked');
    expect(s.account.routeState({ providerId: 'openrouter', funding: 'credit' })).toBe('open');
  });
});

describe('PowerAccountStore absorbing a refusal', () => {
  it('membership_required locks own keys at once, then re-reads me and the balance', async () => {
    const s = setup();
    // Read at startup before the fee was on: nothing needed a membership then.
    await s.account.init(
      me({
        membership: membership({ required: false, status: 'inactive', subscriptionStatus: null }),
        membershipNeededFor: [],
      }),
    );
    const fresh = me({ membership: inactive({ subscriptionStatus: null }) });
    s.api.me.mockResolvedValue(fresh);
    const billingReads = s.api.billing.mock.calls.length;
    expect(s.account.absorb(new ApiError(402, 'membership_required', 'Membership required'))).toBe(
      'membership_required',
    );
    expect([...s.account.lockedFundings()]).toEqual(['own-key']);
    await vi.waitFor(() => expect(s.account.me()).toBe(fresh));
    expect(s.api.billing.mock.calls.length).toBeGreaterThan(billingReads);
  });

  it('payment_required re-reads the balance; key_required the keys; nothing else is taken in', async () => {
    const s = setup();
    await s.account.init(me());
    expect(s.account.absorb(new ApiError(402, 'payment_required', 'No credit'))).toBe(
      'payment_required',
    );
    expect(s.api.billing).toHaveBeenCalledTimes(2);
    expect(s.account.absorb(new ApiError(401, 'key_required', 'Add your key'))).toBe(
      'key_required',
    );
    expect(s.api.keyStatus).toHaveBeenCalledTimes(2);
    expect(s.account.absorb(new ApiError(500, 'internal', 'boom'))).toBeNull();
    expect(s.account.absorb(new Error('offline'))).toBeNull();
    expect(s.api.me).not.toHaveBeenCalled();
    expect(s.account.membership()?.status).toBe('active');
  });
});

describe('PowerAccountStore the default route of a new conversation', () => {
  /** The default power providers (PROVIDERS unset), none with a key. */
  const defaults: ProviderInfo[] = [
    ['anthropic', 'Anthropic', 'claude-opus-5-5'],
    ['openai', 'OpenAI', 'gpt-5'],
    ['openrouter', 'OpenRouter', 'deepseek/deepseek-v4-pro'],
  ].map(([id, label, model]) => ({
    id: id!,
    kind: id === 'anthropic' ? 'anthropic' : 'openai-compatible',
    label: label!,
    models: [{ id: model!, label: model! }],
    defaultModel: model!,
    openModels: id === 'openrouter',
    available: false,
    acceptsUserKey: true,
    keySource: null,
    funding: 'own-key',
  }));
  /** Tangent credit, as listed where it is offered. */
  const tangent: ProviderInfo = {
    ...defaults[2]!,
    label: 'Tangent credit',
    defaultModel: 'max/model',
    available: true,
    acceptsUserKey: false,
    keySource: 'server',
    funding: 'credit',
  };
  const routeOf = (p: ProviderInfo | null) => p && providerRouteKey(p);

  async function start(providers: ProviderInfo[], who: MeResponse, billing?: BillingSummary) {
    const s = setup(providers);
    if (billing) s.api.billing.mockResolvedValue(billing);
    await s.account.init(who);
    return s.account;
  }

  it('no credit offered: the user’s own OpenRouter, whose first send asks for its key', async () => {
    const account = await start(defaults, me({ builtInCredit: false, membershipNeededFor: [] }));
    expect(account.openRoutes()).toEqual([]);
    // Nothing to generate on yet, but a missing key never hides anything.
    expect(account.canGenerate()).toBe(true);
    expect(account.defaultProvider()).toBe(defaults[2]);
    expect(account.defaultProvider()?.defaultModel).toBe('deepseek/deepseek-v4-pro');
  });

  it('credit offered: Tangent credit only while the balance read is above zero', async () => {
    // Anyone could buy more, but for a member whose own keys are open, an empty balance would
    // answer the first send with a 402 for nothing.
    const zero = await start([...defaults, tangent], me(), empty);
    expect(zero.openRoutes()).toEqual([tangent]);
    expect(routeOf(zero.defaultProvider())).toBe('openrouter');

    const some = await start([...defaults, tangent], me());
    expect(some.defaultProvider()).toBe(tangent);

    // A balance that couldn't be read counts as none.
    const s = setup([...defaults, tangent]);
    s.api.billing.mockRejectedValue(new ApiError(500, 'internal', 'boom'));
    await s.account.init(me());
    expect(routeOf(s.account.defaultProvider())).toBe('openrouter');
  });

  it('decides nothing before the providers and the balance are read', async () => {
    const s = setup([...defaults, tangent]);
    let answer!: (b: BillingSummary) => void;
    s.api.billing.mockReturnValue(new Promise<BillingSummary>((r) => (answer = r)));
    expect(s.account.defaultProvider()).toBeNull();
    const started = s.account.init(me());
    await vi.waitFor(() => expect(s.account.providersLoaded()).toBe(true));
    expect(s.account.defaultProvider()).toBeNull();
    answer(summary);
    await started;
    expect(s.account.defaultProvider()).toBe(tangent);
  });

  it('a provider with a key comes first; own keys locked by the membership hand it to credit', async () => {
    const keyed = { ...defaults[1]!, available: true, keySource: 'user' as const };
    const list = [defaults[0]!, keyed, defaults[2]!, tangent];
    const lapsed = me({ membership: membership({ status: 'inactive' }) });
    expect((await start(list, me())).defaultProvider()).toBe(keyed);
    expect((await start(list, lapsed)).defaultProvider()).toBe(tangent);

    // An empty balance, but top-ups are sold: still credit (anyone can buy), not a locked key.
    const buyer = await start(list, lapsed, empty);
    expect(buyer.canGenerate()).toBe(true);
    expect(buyer.defaultProvider()).toBe(tangent);

    // A balance left where top-ups aren't sold: credit can pay, so still credit.
    const holder = await start(list, lapsed, {
      availableMicros: 1_000_000,
      topUpsEnabled: false,
    } as BillingSummary);
    expect(holder.canGenerate()).toBe(true);
    expect(holder.defaultProvider()).toBe(tangent);

    // Nothing can generate (top-ups off, nothing left). Credit that can neither pay nor be
    // bought is a dead end: the locked own key stays the default, which at least leads to the
    // membership.
    const stuck = await start(list, lapsed, spent);
    expect(stuck.canGenerate()).toBe(false);
    expect(stuck.defaultProvider()).toBe(keyed);
  });

  it('a non-member with no key saved: credit only where it can pay or be bought', async () => {
    const lapsed = me({ membership: membership({ status: 'inactive' }) });
    const list = [...defaults, tangent];
    // Credit offered, top-ups not sold, nothing left: the own OpenRouter route, not credit.
    expect(routeOf((await start(list, lapsed, spent)).defaultProvider())).toBe('openrouter');
    // Top-ups sold: credit, whatever the balance.
    expect((await start(list, lapsed, empty)).defaultProvider()).toBe(tangent);
    // Top-ups off, but a balance left: credit.
    const holder = await start(list, lapsed, {
      availableMicros: 1,
      topUpsEnabled: false,
    } as BillingSummary);
    expect(holder.defaultProvider()).toBe(tangent);
  });

  it('never a test provider over a usable route', async () => {
    const fake: ProviderInfo = {
      ...defaults[0]!,
      id: 'fake',
      kind: 'fake',
      available: true,
      scripted: true,
    };
    expect((await start([fake, ...defaults, tangent], me())).defaultProvider()).toBe(tangent);
    expect((await start([fake, ...defaults], me({ builtInCredit: false }))).defaultProvider()).toBe(
      fake,
    );
  });
});
