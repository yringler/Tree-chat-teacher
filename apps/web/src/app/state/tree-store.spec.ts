import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import { Router } from '@angular/router';
import type {
  BillingSummary,
  Branch,
  ChatNode,
  CreateBranchRequest,
  MeResponse,
  MembershipInfo,
  ProviderInfo,
  TreeDetail,
  UpdateBranchRequest,
} from '@tangent/shared';
import { providerRouteKey } from '@tangent/shared';
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

  it('keeps the membership and what needs it from me; loads the balance wherever credit is offered', async () => {
    const s = setup();
    await s.store.init(me({ builtInCredit: false }));
    expect(s.store.membership()?.status).toBe('active');
    expect(s.store.membershipNeededFor()).toEqual(['own-key']);
    expect([...s.store.lockedFundings()]).toEqual([]);
    expect(s.api.billing).not.toHaveBeenCalled();

    // A member too: the default route of a new conversation needs the balance.
    await s.store.init(me());
    expect(s.api.billing).toHaveBeenCalledTimes(1);

    await s.store.init(me({ membership: membership({ status: 'inactive' }) }));
    expect(s.api.billing).toHaveBeenCalledTimes(2);
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

  it('a lapsed member out of credit on a credit branch: a 402 payment_required toasts to /billing, nothing turns read-only', async () => {
    const s = setup();
    s.api.billing.mockResolvedValue({ availableMicros: 0 } as BillingSummary);
    await open(s, inactive());
    s.store.setRoute('t1', 'side', null);
    expect(s.store.readOnly()).toBe(false);
    const callsBefore = s.api.billing.mock.calls.length;
    s.store.fail(new ApiError(402, 'payment_required', 'Not enough Tangent credit.'));
    expect(s.ui.toasts()).toEqual([
      expect.objectContaining({
        kind: 'error',
        text: 'Not enough Tangent credit.',
        link: { label: 'Add credit', path: '/billing' },
      }),
    ]);
    // Not the membership: the credit branch keeps its composer, own keys stay as they were.
    expect(s.store.readOnly()).toBe(false);
    expect(s.store.selectedBranch()?.funding).toBe('credit');
    expect([...s.store.lockedFundings()]).toEqual(['own-key']);
    expect(s.store.membership()?.status).toBe('inactive');
    expect(s.ui.keysDialog()).toBeNull();
    expect(s.api.me).toHaveBeenCalledTimes(0);
    // The balance is read again.
    await vi.waitFor(() => expect(s.api.billing.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('offers no switch to credit without credit left', async () => {
    const s = setup();
    s.api.billing.mockResolvedValue({ availableMicros: 0 } as BillingSummary);
    await open(s, inactive());
    await expect(s.store.switchToCredit('trunk')).resolves.toBe(false);
  });
});

describe('TreeStore the default route of a new conversation (no keys)', () => {
  afterEach(() => vi.restoreAllMocks());

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
  const credit: ProviderInfo = {
    ...defaults[2]!,
    label: 'Tangent credit',
    defaultModel: 'smart/model',
    available: true,
    acceptsUserKey: false,
    keySource: 'server',
    funding: 'credit',
  };
  const routeOf = (p: ProviderInfo | null) => p && providerRouteKey(p);

  it('no credit offered: the user’s own OpenRouter, and the first send asks for its key (not a sign-in)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = setup();
    s.api.providers.mockResolvedValue(defaults);
    await s.store.init(me({ builtInCredit: false, membershipNeededFor: [] }));
    expect(s.store.openRoutes()).toEqual([]);
    // Nothing to generate on yet, but a missing key never hides anything.
    expect(s.store.canGenerate()).toBe(true);
    const first = s.store.defaultProvider();
    expect(first).toBe(defaults[2]);
    expect(first?.defaultModel).toBe('deepseek/deepseek-v4-pro');

    const at = '2026-10-01T00:00:00.000Z';
    const created: TreeDetail = {
      tree: {
        id: 't9',
        accountId: 'p_1',
        title: 'New conversation',
        systemPrompt: null,
        trunkBranchId: 'b9',
        createdAt: at,
        updatedAt: at,
      },
      branches: [
        {
          id: 'b9',
          treeId: 't9',
          parentBranchId: null,
          branchPointNodeId: null,
          contextMode: 'path',
          anchorQuote: null,
          title: 'Main thread',
          titleSource: 'default',
          isPrivate: false,
          providerId: 'openrouter',
          model: 'deepseek/deepseek-v4-pro',
          funding: 'own-key',
          createdAt: at,
          updatedAt: at,
        },
      ],
      nodes: [],
    };
    const createTree = vi.fn(async () => created);
    const message = 'Add your OpenRouter API key to continue this conversation.';
    const sendMessage = vi.fn(async () => {
      throw new ApiError(401, 'key_required', message);
    });
    Object.assign(s.api, { createTree, sendMessage });
    // The home page passes the default provider's route key and model.
    await s.store.startConversation('Hello', providerRouteKey(first!), first!.defaultModel);
    expect(createTree).toHaveBeenCalledWith({
      providerId: 'openrouter',
      funding: 'own-key',
      model: 'deepseek/deepseek-v4-pro',
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    // The keys dialog opens on the OpenRouter key.
    await vi.waitFor(() => expect(s.ui.keysDialog()).toEqual({ provider: 'openrouter' }));
    expect(s.ui.toasts()).toEqual([expect.objectContaining({ kind: 'error', text: message })]);
    expect(s.ui.toasts()[0]?.text).not.toMatch(/session|sign in/i);
  });

  it('credit offered: Tangent credit only while the balance read is above zero', async () => {
    const zero = setup();
    zero.api.providers.mockResolvedValue([...defaults, credit]);
    zero.api.billing.mockResolvedValue({ availableMicros: 0 } as BillingSummary);
    await zero.store.init(me());
    // A member could buy more, but an empty balance would answer the first send with a 402.
    expect(zero.store.openRoutes()).toEqual([credit]);
    expect(routeOf(zero.store.defaultProvider())).toBe('openrouter');

    const some = setup();
    some.api.providers.mockResolvedValue([...defaults, credit]);
    await some.store.init(me());
    expect(some.store.defaultProvider()).toBe(credit);

    // A balance that couldn't be read counts as none.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unread = setup();
    unread.api.providers.mockResolvedValue([...defaults, credit]);
    unread.api.billing.mockRejectedValue(new ApiError(500, 'internal', 'boom'));
    await unread.store.init(me());
    expect(routeOf(unread.store.defaultProvider())).toBe('openrouter');
  });

  it('decides nothing before the providers and the balance are read', async () => {
    const s = setup();
    let answer!: (b: BillingSummary) => void;
    s.api.billing.mockReturnValue(new Promise<BillingSummary>((r) => (answer = r)));
    s.api.providers.mockResolvedValue([...defaults, credit]);
    expect(s.store.defaultProvider()).toBeNull();
    const started = s.store.init(me());
    await vi.waitFor(() => expect(s.store.providersLoaded()).toBe(true));
    expect(s.store.defaultProvider()).toBeNull();
    answer(summary);
    await started;
    expect(s.store.defaultProvider()).toBe(credit);
  });

  it('a provider with a key comes first; own keys locked by the membership hand it to credit that can pay', async () => {
    const keyed = { ...defaults[1]!, available: true, keySource: 'user' as const };
    const list = [defaults[0]!, keyed, defaults[2]!, credit];
    const member = setup();
    member.api.providers.mockResolvedValue(list);
    await member.store.init(me());
    expect(member.store.defaultProvider()).toBe(keyed);

    const lapsed = setup();
    lapsed.api.providers.mockResolvedValue(list);
    await lapsed.store.init(me({ membership: membership({ status: 'inactive' }) }));
    expect(lapsed.store.defaultProvider()).toBe(credit);

    // Nothing can generate: the home page shows the notice; the default stays off credit.
    const stuck = setup();
    stuck.api.providers.mockResolvedValue(list);
    stuck.api.billing.mockResolvedValue({ availableMicros: 0 } as BillingSummary);
    await stuck.store.init(me({ membership: membership({ status: 'inactive' }) }));
    expect(stuck.store.canGenerate()).toBe(false);
    expect(stuck.store.defaultProvider()).toBe(keyed);
  });

  it('never a test provider over a usable route', async () => {
    const fake: ProviderInfo = { ...defaults[0]!, id: 'fake', kind: 'fake', available: true };
    const s = setup();
    s.api.providers.mockResolvedValue([fake, ...defaults, credit]);
    await s.store.init(me());
    expect(s.store.defaultProvider()).toBe(credit);
    const t = setup();
    t.api.providers.mockResolvedValue([fake, ...defaults]);
    await t.store.init(me({ builtInCredit: false }));
    expect(t.store.defaultProvider()).toBe(fake);
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

describe('TreeStore branching with a first message', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const trunk: Branch = {
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
  };
  const reply: ChatNode = {
    id: 'a1',
    treeId: 't1',
    branchId: 'trunk',
    parentId: null,
    seq: 0,
    role: 'assistant',
    content: 'Light is a wave.',
    status: 'complete',
    error: null,
    providerId: 'openrouter',
    model: 'a/b',
    usage: null,
    createdAt: at,
  };

  function open() {
    const s = setup();
    const createBranch = vi.fn(async (req: CreateBranchRequest): Promise<Branch> => ({
      ...trunk,
      id: 'side',
      parentBranchId: 'trunk',
      branchPointNodeId: req.fromNodeId,
      contextMode: req.contextMode ?? 'path',
      title: req.title ?? 'Branch: Light is a wave.',
      titleSource: req.title ? 'user' : 'default',
    }));
    const sendMessage = vi.fn(
      async (_branchId: string, _req: unknown, _signal: AbortSignal) =>
        new Response('', { headers: { 'content-type': 'text/event-stream' } }),
    );
    Object.assign(s.api, { createBranch, sendMessage, streamNode: vi.fn() });
    s.store.detail.set({
      tree: {
        id: 't1',
        accountId: 'p_1',
        title: 'Light',
        systemPrompt: null,
        trunkBranchId: 'trunk',
        createdAt: at,
        updatedAt: at,
      },
      branches: [trunk],
      nodes: [reply],
    });
    s.store.setRoute('t1', null, null);
    const go = vi.spyOn(s.store, 'go');
    return { ...s, createBranch, sendMessage, go };
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('"Ask your own" opens an untitled path branch (titled after its first reply) and asks the question', async () => {
    const s = open();
    const branch = await s.store.askFrom('a1', 'Why does it bend?');
    expect(branch?.id).toBe('side');
    expect(s.createBranch).toHaveBeenCalledWith({
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: null,
    });
    expect(s.go).toHaveBeenCalledWith('side');
    expect(s.store.childBranchesAt('a1').map((b) => b.id)).toEqual(['side']);
    await vi.waitFor(() =>
      expect(s.sendMessage).toHaveBeenCalledWith(
        'side',
        { content: 'Why does it bend?' },
        expect.any(AbortSignal),
      ),
    );
  });

  it('the branch dialog sends its starting message on the chosen settings', async () => {
    const s = open();
    await s.store.startBranch(
      { fromNodeId: 'a1', contextMode: 'summary', anchorQuote: 'a wave', isPrivate: true },
      'And particles?',
    );
    expect(s.createBranch).toHaveBeenCalledWith({
      fromNodeId: 'a1',
      contextMode: 'summary',
      anchorQuote: 'a wave',
      isPrivate: true,
    });
    await vi.waitFor(() =>
      expect(s.sendMessage).toHaveBeenCalledWith(
        'side',
        { content: 'And particles?' },
        expect.any(AbortSignal),
      ),
    );
  });

  it('a tangent is titled after itself and asked; followed again, it just opens', async () => {
    const s = open();
    await s.store.followTangent('a1', 'Waves in water');
    expect(s.createBranch).toHaveBeenCalledWith(
      expect.objectContaining({ fromNodeId: 'a1', contextMode: 'path', title: 'Waves in water' }),
    );
    await vi.waitFor(() => expect(s.sendMessage).toHaveBeenCalledTimes(1));
    await s.store.followTangent('a1', 'Waves in water');
    expect(s.createBranch).toHaveBeenCalledTimes(1);
    expect(s.sendMessage).toHaveBeenCalledTimes(1);
    expect(s.go).toHaveBeenLastCalledWith('side', null);
  });

  it('a branch that cannot be created sends nothing (the caller keeps the text)', async () => {
    const s = open();
    s.createBranch.mockRejectedValueOnce(new ApiError(500, 'internal', 'Nope'));
    await expect(s.store.askFrom('a1', 'Why?')).resolves.toBeNull();
    expect(s.sendMessage).not.toHaveBeenCalled();
    expect(s.ui.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Nope' });
  });
});

describe('TreeStore deleting a branch', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const base: Branch = {
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
  };
  const msg = (id: string, branchId: string, parentId: string | null, seq: number): ChatNode => ({
    id,
    treeId: 't1',
    branchId,
    parentId,
    seq,
    role: seq % 2 === 0 ? 'user' : 'assistant',
    content: id,
    status: 'complete',
    error: null,
    providerId: 'openrouter',
    model: 'a/b',
    usage: null,
    createdAt: at,
  });
  // trunk: u1 a1; `side` from a1 (u2 a2) with `deep` below it from a2 (u3); `other` from a1 (u4).
  const branches: Branch[] = [
    base,
    { ...base, id: 'side', title: 'Side', parentBranchId: 'trunk', branchPointNodeId: 'a1' },
    { ...base, id: 'deep', title: 'Deep', parentBranchId: 'side', branchPointNodeId: 'a2' },
    { ...base, id: 'other', title: 'Other', parentBranchId: 'trunk', branchPointNodeId: 'a1' },
  ];
  const nodes: ChatNode[] = [
    msg('u1', 'trunk', null, 0),
    msg('a1', 'trunk', 'u1', 1),
    msg('u2', 'side', 'a1', 2),
    msg('a2', 'side', 'u2', 3),
    msg('u3', 'deep', 'a2', 4),
    msg('u4', 'other', 'a1', 6),
  ];

  function open(selected: string) {
    const s = setup();
    const deleteBranch = vi.fn(async (_id: string) => ({
      treeId: 't1',
      branchIds: ['side', 'deep'],
      nodeIds: ['u2', 'a2', 'u3'],
    }));
    Object.assign(s.api, { deleteBranch });
    s.store.detail.set({
      tree: {
        id: 't1',
        accountId: 'p_1',
        title: 'Light',
        systemPrompt: null,
        trunkBranchId: 'trunk',
        createdAt: at,
        updatedAt: at,
      },
      branches,
      nodes,
    });
    s.store.setRoute('t1', selected, null);
    const go = vi.spyOn(s.store, 'go');
    return { ...s, deleteBranch, go };
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('deleting the branch the selection is in (or above it) moves to the message it came from', async () => {
    const s = open('deep');
    await expect(s.store.deleteBranch('side')).resolves.toBe(true);
    expect(s.deleteBranch).toHaveBeenCalledWith('side');
    expect(s.go).toHaveBeenCalledWith('trunk', 'a1', true);
    const idx = s.store.index();
    expect([...(idx?.branches.keys() ?? [])].sort()).toEqual(['other', 'trunk']);
    expect(idx?.nodes.has('u3')).toBe(false);
    expect(s.store.childBranchesAt('a1').map((b) => b.id)).toEqual(['other']);
    expect(s.ui.toasts().at(-1)?.text).toBe('Deleted the branch and 1 below it');
  });

  it('a selection elsewhere stays where it is', async () => {
    const s = open('other');
    await s.store.deleteBranch('side');
    expect(s.go).not.toHaveBeenCalled();
    expect(s.store.selectedBranchId()).toBe('other');
    expect(s.store.index()?.branches.has('side')).toBe(false);
  });

  it('a refused delete leaves everything as it was', async () => {
    const s = open('side');
    s.deleteBranch.mockRejectedValueOnce(new ApiError(409, 'conflict', 'Still generating'));
    await expect(s.store.deleteBranch('side')).resolves.toBe(false);
    expect(s.go).not.toHaveBeenCalled();
    expect(s.store.index()?.branches.size).toBe(4);
    expect(s.store.selectedBranchId()).toBe('side');
    expect(s.ui.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Still generating' });
  });
});
