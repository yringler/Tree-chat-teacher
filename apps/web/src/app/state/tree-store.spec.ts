import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import { Router } from '@angular/router';
import type {
  BillingSummary,
  Branch,
  ChatNode,
  MeResponse,
  MembershipInfo,
  ProviderInfo,
  TreeDetail,
  UpdateBranchRequest,
} from '@tangent/shared';
import { ApiClient, ApiError } from '@tangent/web-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeStore } from './tree-store';
import { UiStore } from './ui-store';

function membership(over: Partial<MembershipInfo> = {}): MembershipInfo {
  return {
    required: true,
    status: 'active',
    subscriptionStatus: 'active',
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
    includedCreditCents: 500,
    ...over,
  };
}

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
    featuredConversations: false,
    ...over,
  };
}

const summary = { availableMicros: 2_500_000 } as BillingSummary;

function setup() {
  const api = {
    me: vi.fn(async (): Promise<MeResponse> => me()),
    providers: vi.fn(async (): Promise<ProviderInfo[]> => []),
    listTrees: vi.fn(async () => []),
    keyStatus: vi.fn(async () => ({ enabled: true, hasKey: false, providers: [] })),
    billing: vi.fn(async (): Promise<BillingSummary> => summary),
  };
  const injector = Injector.create({
    providers: [
      { provide: TreeStore },
      { provide: UiStore },
      { provide: ApiClient, useValue: api },
      { provide: Router, useValue: { navigate: vi.fn(async () => true) } },
    ],
  });
  return { store: injector.get(TreeStore), ui: injector.get(UiStore), api };
}

describe('TreeStore membership and credit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the membership and what needs it from me; loads the balance only without a membership', async () => {
    const s = setup();
    await s.store.init(me());
    expect(s.store.membership()?.status).toBe('active');
    expect(s.store.membershipNeededFor()).toEqual(['own-key']);
    expect([...s.store.lockedFundings()]).toEqual([]);
    expect(s.api.billing).not.toHaveBeenCalled();

    await s.store.init(me({ membership: membership({ status: 'inactive' }) }));
    expect(s.api.billing).toHaveBeenCalled();
    expect(s.store.creditCarriesOn()).toBe(true);
    expect([...s.store.lockedFundings()]).toEqual(['own-key']);
  });

  it('a 402 payment_required links to /billing and refreshes the balance', async () => {
    const s = setup();
    await s.store.init(me());
    s.store.fail(new ApiError(402, 'payment_required', 'Not enough credit'));
    expect(s.ui.toasts()).toEqual([
      expect.objectContaining({
        kind: 'error',
        text: 'Not enough credit',
        link: { label: 'Add credit', path: '/billing' },
      }),
    ]);
    await vi.waitFor(() => expect(s.store.billing()).toBe(summary));
  });

  it('key_required still opens the keys dialog', async () => {
    const s = setup();
    await s.store.init(me());
    s.store.fail(new ApiError(401, 'key_required', 'Add your key'));
    expect(s.ui.keysDialog()).toEqual({ provider: null });
    expect(s.ui.toasts()[0]?.link).toBeUndefined();
  });

  it('refreshBilling keeps quiet when the summary fails', async () => {
    const s = setup();
    s.api.billing.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    await s.store.refreshBilling();
    expect(s.store.billing()).toBeNull();
    expect(s.ui.toasts()).toEqual([]);
    await s.store.refreshBilling();
    expect(s.store.billing()).toBe(summary);
  });
});

describe('TreeStore read-only power without a membership', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  const inactive = (over: Partial<MembershipInfo> = {}) =>
    membership({ status: 'inactive', subscriptionStatus: 'canceled', ...over });

  /** A tree whose trunk is on the user's OpenRouter key, with a side branch on Tangent credit. */
  function tree(): TreeDetail {
    const at = '2026-10-01T00:00:00.000Z';
    const branch = (over: Partial<Branch>): Branch => ({
      id: 'trunk',
      treeId: 't1',
      parentBranchId: null,
      branchPointNodeId: null,
      contextMode: 'path',
      anchorQuote: null,
      title: 'Main thread',
      titleSource: 'default',
      isPrivate: false,
      providerId: 'openrouter',
      model: 'a/b',
      funding: 'own-key',
      createdAt: at,
      updatedAt: at,
      ...over,
    });
    const node = (over: Partial<ChatNode>): ChatNode => ({
      id: 'n1',
      treeId: 't1',
      branchId: 'trunk',
      parentId: null,
      seq: 0,
      role: 'user',
      content: 'Hi',
      status: 'complete',
      error: null,
      providerId: null,
      model: null,
      usage: null,
      createdAt: at,
      ...over,
    });
    return {
      tree: {
        id: 't1',
        accountId: 'p_1',
        title: 'Primes',
        systemPrompt: null,
        trunkBranchId: 'trunk',
        createdAt: at,
        updatedAt: at,
      },
      branches: [
        branch({}),
        branch({
          id: 'side',
          parentBranchId: 'trunk',
          branchPointNodeId: 'n2',
          title: 'On credit',
          funding: 'credit',
          model: 'c/d',
        }),
      ],
      nodes: [
        node({}),
        node({
          id: 'n2',
          parentId: 'n1',
          seq: 1,
          role: 'assistant',
          content: 'Hello',
          providerId: 'openrouter',
          model: 'a/b',
        }),
      ],
    };
  }

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
    models: [{ id: 'smart/model', label: 'Smart' }],
    defaultModel: 'smart/model',
    acceptsUserKey: false,
    keySource: 'server',
    funding: 'credit',
  };

  async function open(
    s: ReturnType<typeof setup>,
    m: MembershipInfo,
    over: Partial<MeResponse> = {},
  ) {
    s.api.providers.mockResolvedValue([ownKey, credit]);
    await s.store.init(me({ membership: m, ...over }));
    s.store.detail.set(tree());
    s.store.setRoute('t1', null, null);
  }

  it('a member is never read-only, and generates on every route', async () => {
    const s = setup();
    await open(s, membership());
    expect(s.store.readOnly()).toBe(false);
    expect(s.store.openRoutes()).toEqual([ownKey, credit]);
    expect(s.store.canReview(s.store.selectedBranch())).toBe(true);
  });

  it('only the membership hides anything: not a missing key, nor a provider list not read yet', async () => {
    const s = setup();
    expect(s.store.canGenerate()).toBe(true);
    s.api.providers.mockResolvedValue([{ ...ownKey, available: false }]);
    await s.store.init(me());
    expect(s.store.openRoutes()).toEqual([]);
    expect(s.store.canGenerate()).toBe(true);

    const t = setup();
    t.api.billing.mockResolvedValue({ availableMicros: 0 } as BillingSummary);
    t.store.membership.set(inactive());
    t.store.membershipNeededFor.set(['own-key']);
    expect(t.store.canGenerate()).toBe(true); // providers not read yet
    await t.store.refreshKeys();
    expect(t.store.canGenerate()).toBe(false);
  });

  it('without a membership, a branch on the own key is read-only; one on Tangent credit is not', async () => {
    const s = setup();
    await open(s, inactive());
    expect(s.store.selectedBranchId()).toBe('trunk');
    expect(s.store.readOnly()).toBe(true);
    expect(s.store.canReview(s.store.selectedBranch())).toBe(false);
    // Credit is left (the balance loaded on init), so it can still pay.
    expect(s.store.openRoutes()).toEqual([credit]);
    expect(s.store.canGenerate()).toBe(true);
    expect(s.store.creditRoute()).toBe(credit);
    expect(s.store.defaultProvider()).toBe(credit);

    s.store.setRoute('t1', 'side', null);
    expect(s.store.readOnly()).toBe(false);
    expect(s.store.canReview(s.store.selectedBranch())).toBe(true);
  });

  it('with no credit left either, power is read-only throughout', async () => {
    const s = setup();
    s.api.billing.mockResolvedValue({ availableMicros: 0 } as BillingSummary);
    await open(s, inactive());
    expect(s.store.readOnly()).toBe(true);
    expect(s.store.openRoutes()).toEqual([]);
    expect(s.store.canGenerate()).toBe(false);
    expect(s.store.creditRoute()).toBeNull();
    // A credit branch isn't read-only: its sends get the usual 402 payment_required.
    s.store.setRoute('t1', 'side', null);
    expect(s.store.readOnly()).toBe(false);
  });

  it('never read-only where no membership is required (the fee off, a server without billing)', async () => {
    const s = setup();
    await open(s, membership({ required: false, status: 'inactive', subscriptionStatus: null }), {
      membershipNeededFor: [],
    });
    expect([...s.store.lockedFundings()]).toEqual([]);
    expect(s.store.readOnly()).toBe(false);
    expect(s.store.canGenerate()).toBe(true);
    // Whatever a stale list said: without a requirement nothing is locked.
    s.store.membershipNeededFor.set(['own-key']);
    expect(s.store.readOnly()).toBe(false);
  });

  it('a 402 membership_required turns the branch read-only (no toast), and re-reads me and the balance', async () => {
    const s = setup();
    // Read at startup before the fee was on: nothing needed a membership then.
    await open(s, membership({ required: false, status: 'inactive', subscriptionStatus: null }), {
      membershipNeededFor: [],
    });
    expect(s.store.readOnly()).toBe(false);
    const fresh = me({ membership: inactive({ subscriptionStatus: null }) });
    s.api.me.mockResolvedValue(fresh);
    s.store.fail(new ApiError(402, 'membership_required', 'Membership required'));
    expect(s.store.readOnly()).toBe(true);
    expect(s.ui.toasts()).toEqual([]);
    await vi.waitFor(() => expect(s.store.me()).toBe(fresh));
    expect(s.store.readOnly()).toBe(true);
    expect(s.api.billing).toHaveBeenCalled();
  });

  it('a 402 membership_required elsewhere (a review on a credit branch) gets a toast to the billing page', async () => {
    const s = setup();
    await open(s, inactive());
    s.store.setRoute('t1', 'side', null);
    s.store.fail(new ApiError(402, 'membership_required', 'Membership required'));
    expect(s.store.readOnly()).toBe(false);
    expect(s.ui.toasts()).toEqual([
      expect.objectContaining({ kind: 'error', link: { label: 'Membership', path: '/billing' } }),
    ]);
  });

  it('a summary from the billing page (a renewal or a code) lifts read-only', async () => {
    const s = setup();
    await open(s, inactive());
    expect(s.store.readOnly()).toBe(true);
    s.store.applyBilling({ ...summary, membership: membership({ status: 'waived' }) });
    expect(s.store.readOnly()).toBe(false);
  });

  it('"Continue with Tangent credit" moves the branch onto credit, keeping a model credit serves', async () => {
    const s = setup();
    await open(s, inactive());
    const updateBranch = vi.fn(async (id: string, req: UpdateBranchRequest) => ({
      ...tree().branches.find((b) => b.id === id)!,
      ...req,
    }));
    (s.api as unknown as { updateBranch: typeof updateBranch }).updateBranch = updateBranch;
    await expect(s.store.switchToCredit('trunk')).resolves.toBe(true);
    // `a/b` is a well-formed id and credit's OpenRouter takes any (openModels).
    expect(updateBranch).toHaveBeenCalledWith('trunk', {
      providerId: 'openrouter',
      funding: 'credit',
      model: 'a/b',
    });
    expect(s.store.readOnly()).toBe(false);
    expect(s.ui.toasts()[0]?.text).toBe('“Main thread” now uses Tangent credit (a/b)');
  });

  it('offers no switch to credit without credit left', async () => {
    const s = setup();
    s.api.billing.mockResolvedValue({ availableMicros: 0 } as BillingSummary);
    await open(s, inactive());
    await expect(s.store.switchToCredit('trunk')).resolves.toBe(false);
  });
});

describe('TreeStore routes (provider + funding)', () => {
  const entry = (funding: 'own-key' | 'credit', label: string): ProviderInfo => ({
    id: 'openrouter',
    kind: 'openai-compatible',
    label,
    models: [],
    defaultModel: 'a/b',
    openModels: true,
    available: true,
    acceptsUserKey: funding === 'own-key',
    keySource: funding === 'own-key' ? 'user' : 'server',
    funding,
  });

  it('tells the built-in endpoint on the user key from Tangent credit, and sends the funding', async () => {
    const s = setup();
    s.store.providers.set([entry('own-key', 'OpenRouter'), entry('credit', 'Tangent credit')]);
    expect(s.store.providerOf({ providerId: 'openrouter' })?.label).toBe('OpenRouter');
    expect(s.store.providerOf({ providerId: 'openrouter', funding: 'credit' })?.label).toBe(
      'Tangent credit',
    );
    const createTree = vi.fn(async () => {
      throw new ApiError(400, 'bad_request', 'stop here');
    });
    (s.api as unknown as { createTree: typeof createTree }).createTree = createTree;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await s.store.startConversation('Hi', 'openrouter@credit', 'a/b');
    expect(createTree).toHaveBeenCalledWith({
      providerId: 'openrouter',
      funding: 'credit',
      model: 'a/b',
    });
  });
});
