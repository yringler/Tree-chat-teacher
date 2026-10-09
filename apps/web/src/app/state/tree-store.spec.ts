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
  NodeLink,
  PoolStatusResponse,
  ProviderInfo,
  StreamEvent,
  TreeDetail,
  TreeSummary,
  UpdateBranchRequest,
} from '@tangent/shared';
import { providerRouteKey } from '@tangent/shared';
import { ApiClient, ApiError, ToastStore } from '@tangent/web-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeStore } from './tree-store';
import { SettingsStore } from './settings-store';
import { UiStore } from './ui-store';

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

function setup() {
  const api = {
    me: vi.fn(async (): Promise<MeResponse> => me()),
    providers: vi.fn(async (): Promise<ProviderInfo[]> => []),
    listTrees: vi.fn(async (): Promise<TreeSummary[]> => []),
    keyStatus: vi.fn(async () => ({ enabled: true, hasKey: false, providers: [] })),
    billing: vi.fn(async (): Promise<BillingSummary> => summary),
    poolStatus: vi.fn(async () => ({ enabled: false }) as PoolStatusResponse),
  };
  const router = { navigate: vi.fn(async () => true) };
  const injector = Injector.create({
    providers: [
      { provide: TreeStore },
      { provide: UiStore },
      { provide: ToastStore },
      { provide: SettingsStore },
      { provide: ApiClient, useValue: api },
      { provide: Router, useValue: router },
    ],
  });
  return {
    store: injector.get(TreeStore),
    ui: injector.get(UiStore),
    toasts: injector.get(ToastStore),
    settings: injector.get(SettingsStore),
    api,
    router,
  };
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

  it('a 402 payment_required links to /billing and refreshes the balance', async () => {
    const s = setup();
    await s.store.init(me());
    s.store.fail(new ApiError(402, 'payment_required', 'Not enough credit'));
    expect(s.toasts.toasts()).toEqual([
      expect.objectContaining({
        kind: 'error',
        text: 'Not enough credit',
        link: { label: 'Add credit', path: '/billing' },
      }),
    ]);
    await vi.waitFor(() => expect(s.store.account.billing()).toBe(summary));
  });

  it('key_required still opens the keys dialog', async () => {
    const s = setup();
    await s.store.init(me());
    s.store.fail(new ApiError(401, 'key_required', 'Add your key'));
    expect(s.ui.keysDialog()).toEqual({ provider: null });
    expect(s.toasts.toasts()[0]?.link).toBeUndefined();
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
      links: [],
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
    models: [{ id: 'max/model', label: 'Max' }],
    defaultModel: 'max/model',
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
    expect(s.store.account.openRoutes()).toEqual([ownKey, credit]);
    expect(s.store.canReview(s.store.selectedBranch())).toBe(true);
  });

  it('without a membership, a branch on the own key is read-only; one on Tangent credit is not', async () => {
    const s = setup();
    await open(s, inactive());
    expect(s.store.selectedBranchId()).toBe('trunk');
    expect(s.store.readOnly()).toBe(true);
    expect(s.store.canReview(s.store.selectedBranch())).toBe(false);
    // Credit is left (the balance loaded on init), so it can still pay.
    expect(s.store.account.openRoutes()).toEqual([credit]);
    expect(s.store.account.canGenerate()).toBe(true);
    expect(s.store.account.creditRoute()).toBe(credit);
    expect(s.store.account.defaultProvider()).toBe(credit);

    s.store.setRoute('t1', 'side', null);
    expect(s.store.readOnly()).toBe(false);
    expect(s.store.canReview(s.store.selectedBranch())).toBe(true);
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
    expect(s.toasts.toasts()).toEqual([]);
    await vi.waitFor(() => expect(s.store.account.me()).toBe(fresh));
    expect(s.store.readOnly()).toBe(true);
    expect(s.api.billing).toHaveBeenCalled();
  });

  it('a 402 membership_required elsewhere (a review on a credit branch) gets a toast to the billing page', async () => {
    const s = setup();
    await open(s, inactive());
    s.store.setRoute('t1', 'side', null);
    s.store.fail(new ApiError(402, 'membership_required', 'Membership required'));
    expect(s.store.readOnly()).toBe(false);
    expect(s.toasts.toasts()).toEqual([
      expect.objectContaining({ kind: 'error', link: { label: 'Membership', path: '/billing' } }),
    ]);
  });

  it('a summary from the billing page (a renewal or a code) lifts read-only', async () => {
    const s = setup();
    await open(s, inactive());
    expect(s.store.readOnly()).toBe(true);
    s.store.account.applyBilling({ ...summary, membership: membership({ status: 'waived' }) });
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
    expect(s.toasts.toasts()[0]?.text).toBe('“Main thread” now uses Tangent credit (a/b)');
  });

  it('a lapsed member out of credit on a credit branch: a 402 payment_required toasts to /billing, nothing turns read-only', async () => {
    const s = setup();
    s.api.billing.mockResolvedValue(empty);
    await open(s, inactive());
    s.store.setRoute('t1', 'side', null);
    expect(s.store.readOnly()).toBe(false);
    const callsBefore = s.api.billing.mock.calls.length;
    s.store.fail(new ApiError(402, 'payment_required', 'Not enough Tangent credit.'));
    expect(s.toasts.toasts()).toEqual([
      expect.objectContaining({
        kind: 'error',
        text: 'Not enough Tangent credit.',
        link: { label: 'Add credit', path: '/billing' },
      }),
    ]);
    // Not the membership: the credit branch keeps its composer, own keys stay as they were.
    expect(s.store.readOnly()).toBe(false);
    expect(s.store.selectedBranch()?.funding).toBe('credit');
    expect([...s.store.account.lockedFundings()]).toEqual(['own-key']);
    expect(s.store.account.membership()?.status).toBe('inactive');
    expect(s.ui.keysDialog()).toBeNull();
    expect(s.api.me).toHaveBeenCalledTimes(0);
    // The balance is read again.
    await vi.waitFor(() => expect(s.api.billing.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('offers no switch to credit where it can be neither bought nor spent', async () => {
    const s = setup();
    s.api.billing.mockResolvedValue(spent);
    await open(s, inactive());
    await expect(s.store.switchToCredit('trunk')).resolves.toBe(false);
  });

  it('offers the switch to credit with an empty balance where top-ups are sold', async () => {
    const s = setup();
    s.api.billing.mockResolvedValue(empty);
    await open(s, inactive());
    const updateBranch = vi.fn(async (id: string, req: UpdateBranchRequest) => ({
      ...tree().branches.find((b) => b.id === id)!,
      ...req,
    }));
    (s.api as unknown as { updateBranch: typeof updateBranch }).updateBranch = updateBranch;
    await expect(s.store.switchToCredit('trunk')).resolves.toBe(true);
    expect(s.store.readOnly()).toBe(false);
  });

  describe('a branch on the own key, with no key in this browser', () => {
    const noKey: ProviderInfo = { ...ownKey, available: false, keySource: null };
    const keyRequired = () =>
      new ApiError(
        401,
        'key_required',
        'Add your OpenRouter API key to continue this conversation.',
      );
    const sse = (events: StreamEvent[]): Response =>
      new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });

    async function openNoKey() {
      const s = setup();
      s.api.providers.mockResolvedValue([noKey, credit]);
      await s.store.init(me());
      s.store.detail.set(tree());
      s.store.setRoute('t1', null, null);
      const sendMessage = vi.fn(
        async (_b: string, _req: unknown, _signal: AbortSignal): Promise<Response> => {
          throw keyRequired();
        },
      );
      const updateBranch = vi.fn(async (id: string, req: UpdateBranchRequest) => ({
        ...tree().branches.find((b) => b.id === id)!,
        ...req,
      }));
      Object.assign(s.api, {
        sendMessage,
        updateBranch,
        streamNode: vi.fn(),
        saveKey: vi.fn(async () => undefined),
      });
      return { ...s, sendMessage, updateBranch };
    }

    it('says so before anything is sent', async () => {
      const s = await openNoKey();
      expect(s.store.readOnly()).toBe(false);
      expect(s.store.account.keyMissing(s.store.selectedBranch()!)).toBe(true);
      // Tangent credit never needs a key.
      expect(s.store.account.keyMissing({ providerId: 'openrouter', funding: 'credit' })).toBe(
        false,
      );
    });

    it('a refused send keeps the message and opens the keys dialog on the branch’s provider', async () => {
      const s = await openNoKey();
      await expect(s.store.send('trunk', 'Why primes?')).resolves.toBe(false);
      expect(s.store.blockedSends()).toEqual([{ branchId: 'trunk', content: 'Why primes?' }]);
      expect(s.store.blockedBranch()?.id).toBe('trunk');
      expect(s.store.unsentDrafts().get('trunk')).toBe('Why primes?');
      expect(s.ui.keysDialog()).toEqual({ provider: 'openrouter' });
      // Nothing reached the tree: the composer keeps the text.
      expect(s.ui.composerSent()).toBeNull();
    });

    it('"Continue on Tangent credit" moves the branch onto credit and sends the message there', async () => {
      const s = await openNoKey();
      await s.store.send('trunk', 'Why primes?');
      s.sendMessage.mockImplementation(async () => sse([]));
      await expect(s.store.resumeOnCredit()).resolves.toBe(true);
      expect(s.updateBranch).toHaveBeenCalledWith('trunk', {
        providerId: 'openrouter',
        funding: 'credit',
        model: 'a/b',
      });
      expect(s.store.selectedBranch()?.funding).toBe('credit');
      expect(s.sendMessage).toHaveBeenLastCalledWith(
        'trunk',
        { content: 'Why primes?' },
        expect.any(AbortSignal),
      );
      expect(s.store.blockedSends()).toEqual([]);
      expect(s.ui.keysDialog()).toBeNull();
    });

    it('saving the key sends the waiting message on it', async () => {
      const s = await openNoKey();
      await s.store.send('trunk', 'Why primes?');
      // Another provider's key carries nothing on.
      s.store.resumeAfterKey('anthropic');
      expect(s.sendMessage).toHaveBeenCalledTimes(1);

      s.api.providers.mockResolvedValue([ownKey, credit]);
      s.sendMessage.mockImplementation(async () => sse([]));
      await expect(s.store.account.saveKey('openrouter', 'sk-or-1')).resolves.toBe(true);
      s.store.resumeAfterKey('openrouter');
      expect(s.sendMessage).toHaveBeenCalledTimes(2);
      expect(s.sendMessage).toHaveBeenLastCalledWith(
        'trunk',
        { content: 'Why primes?' },
        expect.any(AbortSignal),
      );
      expect(s.store.blockedSends()).toEqual([]);
      expect(s.ui.keysDialog()).toBeNull();
    });

    it('sends the reply length set in Settings; Auto sends none', async () => {
      const s = await openNoKey();
      s.settings.update({ maxOutputTokens: 16_384 });
      try {
        await s.store.send('trunk', 'Why primes?');
        expect(s.sendMessage).toHaveBeenLastCalledWith(
          'trunk',
          { content: 'Why primes?', maxOutputTokens: 16_384 },
          expect.any(AbortSignal),
        );
      } finally {
        s.settings.update({ maxOutputTokens: null });
      }
      await s.store.send('trunk', 'Why primes?');
      expect(s.sendMessage).toHaveBeenLastCalledWith(
        'trunk',
        { content: 'Why primes?' },
        expect.any(AbortSignal),
      );
    });

    it('sends the input limit and the over-limit choice set in Settings', async () => {
      const s = await openNoKey();
      s.settings.update({ maxInputTokens: 60_000, inputOverflow: 'truncate' });
      try {
        await s.store.send('trunk', 'Why primes?');
        expect(s.sendMessage).toHaveBeenLastCalledWith(
          'trunk',
          { content: 'Why primes?', maxInputTokens: 60_000, inputOverflow: 'truncate' },
          expect.any(AbortSignal),
        );
      } finally {
        s.settings.update({ maxInputTokens: null, inputOverflow: 'compact' });
      }
    });

    it('closing the dialog sends nothing and leaves the text for the composer', async () => {
      const s = await openNoKey();
      await s.store.send('trunk', 'Why primes?');
      s.store.dropBlockedSends();
      expect(s.store.blockedSends()).toEqual([]);
      expect(s.store.unsentDrafts().get('trunk')).toBe('Why primes?');
      expect(s.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('any failure before the reply starts keeps the text; a started reply lets it go', async () => {
      const s = await openNoKey();
      s.sendMessage.mockRejectedValueOnce(new ApiError(0, 'network', 'Network error'));
      await s.store.send('side', 'And twins?');
      expect(s.store.unsentDrafts().get('side')).toBe('And twins?');
      expect(s.store.blockedSends()).toEqual([]);

      const at = '2026-10-01T00:00:00.000Z';
      const userNode: ChatNode = {
        id: 'u9',
        treeId: 't1',
        branchId: 'side',
        parentId: 'n2',
        seq: 2,
        role: 'user',
        content: 'And twins?',
        status: 'complete',
        error: null,
        providerId: null,
        model: null,
        usage: null,
        createdAt: at,
      };
      const reply: ChatNode = { ...userNode, id: 'a9', role: 'assistant', content: '' };
      const side = tree().branches[1]!;
      s.sendMessage.mockImplementation(async () =>
        sse([
          {
            type: 'start',
            userNode,
            assistantNode: { ...reply, status: 'streaming' },
            branch: side,
          },
          { type: 'done', node: { ...reply, content: 'Yes.' }, branch: side },
        ]),
      );
      await s.store.send('side', 'And twins?');
      expect(s.store.unsentDrafts().has('side')).toBe(false);
      expect(s.ui.composerSent()).toEqual({ seq: 1, text: 'And twins?' });
    });
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

  it('no credit offered: the user’s own OpenRouter, and the first send asks for its key (not a sign-in)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = setup();
    s.api.providers.mockResolvedValue(defaults);
    await s.store.init(me({ builtInCredit: false, membershipNeededFor: [] }));
    expect(s.store.account.openRoutes()).toEqual([]);
    // Nothing to generate on yet, but a missing key never hides anything.
    expect(s.store.account.canGenerate()).toBe(true);
    const first = s.store.account.defaultProvider();
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
      links: [],
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
    expect(s.toasts.toasts()).toEqual([expect.objectContaining({ kind: 'error', text: message })]);
    expect(s.toasts.toasts()[0]?.text).not.toMatch(/session|sign in/i);
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
    s.store.account.providers.set([
      entry('own-key', 'OpenRouter'),
      entry('credit', 'Tangent credit'),
    ]);
    expect(s.store.account.providerOf({ providerId: 'openrouter' })?.label).toBe('OpenRouter');
    expect(s.store.account.providerOf({ providerId: 'openrouter', funding: 'credit' })?.label).toBe(
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
      links: [],
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

  it('"Ask about this" opens a path branch quoting the selection, ready to type and unsent', async () => {
    const s = open();
    const before = s.ui.composerFocus();
    const branch = await s.store.createBranch({
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: 'a wave',
    });
    expect(branch?.id).toBe('side');
    expect(s.createBranch).toHaveBeenCalledWith({
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: 'a wave',
    });
    expect(s.go).toHaveBeenCalledWith('side');
    expect(s.ui.composerFocus()).toBe(before + 1);
    expect(s.sendMessage).not.toHaveBeenCalled();
  });

  it('a branch that cannot be created sends nothing (the caller keeps the text)', async () => {
    const s = open();
    s.createBranch.mockRejectedValueOnce(new ApiError(500, 'internal', 'Nope'));
    await expect(s.store.askFrom('a1', 'Why?')).resolves.toBeNull();
    expect(s.sendMessage).not.toHaveBeenCalled();
    expect(s.toasts.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Nope' });
  });
});

describe('TreeStore links between messages', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

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
  const link = (over: Partial<NodeLink>): NodeLink => ({
    id: 'l1',
    treeId: 't1',
    sourceNodeId: 'n2',
    targetNodeId: 'n3',
    note: null,
    origin: 'user',
    createdAt: at,
    updatedAt: at,
    ...over,
  });

  /** Main thread n1 → n2; "Owls" off n2 (n3, n4), "Deeper" off n4 (n5); n2 linked to n3. */
  function tree(): TreeDetail {
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
        branch({ id: 'owls', parentBranchId: 'trunk', branchPointNodeId: 'n2', title: 'Owls' }),
        branch({ id: 'deeper', parentBranchId: 'owls', branchPointNodeId: 'n4', title: 'Deeper' }),
      ],
      nodes: [
        node({}),
        node({ id: 'n2', parentId: 'n1', seq: 1, role: 'assistant', content: 'Hello' }),
        node({ id: 'n3', branchId: 'owls', parentId: 'n2', content: 'Owls?' }),
        node({ id: 'n4', branchId: 'owls', parentId: 'n3', seq: 1, role: 'assistant' }),
        node({ id: 'n5', branchId: 'deeper', parentId: 'n4', content: 'Deeper?' }),
      ],
      links: [link({})],
    };
  }

  function open() {
    const s = setup();
    const api = Object.assign(s.api, {
      createLink: vi.fn(
        async (req: { fromNodeId: string; toNodeId: string; note?: string | null }) => ({
          link: link({
            id: 'l2',
            sourceNodeId: req.fromNodeId,
            targetNodeId: req.toNodeId,
            note: req.note ?? null,
          }),
          created: true,
        }),
      ),
      updateLink: vi.fn(async (id: string, req: { note: string | null }) =>
        link({ id, note: req.note }),
      ),
      deleteLink: vi.fn(async () => undefined),
      deleteBranch: vi.fn(async () => ({
        treeId: 't1',
        branchIds: ['owls', 'deeper'],
        nodeIds: ['n3', 'n4', 'n5'],
      })),
    });
    s.store.detail.set(tree());
    s.store.setRoute('t1', 'deeper', 'n5');
    return { ...s, api };
  }

  it('indexes the links by both ends, and counts them per branch', () => {
    const s = open();
    expect(s.store.links()).toHaveLength(1);
    expect(
      s.store
        .linksByNode()
        .get('n2')
        ?.map((l) => l.id),
    ).toEqual(['l1']);
    expect(
      s.store
        .linksByNode()
        .get('n3')
        ?.map((l) => l.id),
    ).toEqual(['l1']);
    expect([...s.store.linkCounts()]).toEqual([
      ['trunk', 1],
      ['owls', 1],
    ]);
  });

  it('createLink adds the link, opens both ends and says so', async () => {
    const s = open();
    const made = await s.store.createLink('n5', 'n1', 'Same question');
    expect(s.api.createLink).toHaveBeenCalledWith({
      fromNodeId: 'n5',
      toNodeId: 'n1',
      note: 'Same question',
    });
    expect(made?.id).toBe('l2');
    expect(s.store.links().map((l) => l.id)).toEqual(['l1', 'l2']);
    expect(s.store.linksByNode().get('n1')?.[0]?.note).toBe('Same question');
    expect([...s.ui.relatedOpen()]).toEqual(['n5', 'n1']);
    expect(s.toasts.toasts().at(-1)?.text).toBe('Messages linked');
  });

  it('deleting a branch drops the links touching its messages, and pick mode from them', async () => {
    const s = open();
    s.store.detail.update((d) =>
      d
        ? {
            ...d,
            links: [
              ...d.links,
              link({ id: 'l2', sourceNodeId: 'n1', targetNodeId: 'n2' }),
              link({ id: 'l3', sourceNodeId: 'n5', targetNodeId: 'n1' }),
            ],
          }
        : d,
    );
    s.ui.linkPick.set({ fromNodeId: 'n5' });
    s.ui.linkReturn.set({
      branchId: 'deeper',
      focusNodeId: 'n5',
      label: 'Deeper',
      toBranchId: 'trunk',
      toNodeId: 'n1',
    });
    await expect(s.store.deleteBranch('owls')).resolves.toBe(true);
    expect(s.store.links().map((l) => l.id)).toEqual(['l2']);
    expect(s.ui.linkPick()).toBeNull();
    expect(s.ui.linkReturn()).toBeNull();
  });

  it('openNode goes to the other end, focused, and remembers where it came from', () => {
    const s = open();
    expect(s.store.openNode('n2', 'n5')).toBe(true);
    expect(s.router.navigate).toHaveBeenLastCalledWith(['/t', 't1', 'b', 'trunk'], {
      queryParams: { m: 'n2' },
      replaceUrl: false,
    });
    expect(s.ui.linkReturn()).toEqual({
      branchId: 'deeper',
      focusNodeId: 'n5',
      label: 'Deeper',
      toBranchId: 'trunk',
      toNodeId: 'n2',
    });
    expect(s.ui.relatedOpen().has('n2')).toBe(true);
    // Without the message it was opened from: the focused one.
    s.store.setRoute('t1', 'owls', 'n4');
    s.store.openNode('n2');
    expect(s.ui.linkReturn()?.focusNodeId).toBe('n4');
    // A message that isn't in the tree goes nowhere.
    expect(s.store.openNode('gone')).toBe(false);
  });

  it('opening another tree ends pick mode and forgets the return pill', () => {
    const s = open();
    s.ui.linkPick.set({ fromNodeId: 'n5' });
    s.ui.linkDialog.set({ fromNodeId: 'n5' });
    s.store.openNode('n2', 'n5');
    s.store.setRoute('t1', 'trunk', 'n2');
    expect(s.ui.linkPick()).not.toBeNull();
    s.store.setRoute('t2', null, null);
    expect(s.ui.linkPick()).toBeNull();
    expect(s.ui.linkDialog()).toBeNull();
    expect(s.ui.linkReturn()).toBeNull();
  });

  it('Escape ends pick mode after closing dialogs', () => {
    const s = open();
    s.ui.linkPick.set({ fromNodeId: 'n5' });
    s.ui.linkDialog.set({ fromNodeId: 'n5' });
    expect(s.ui.anyDialogOpen()).toBe(true);
    expect(s.ui.closeTop()).toBe(true);
    expect(s.ui.linkDialog()).toBeNull();
    expect(s.ui.linkPick()).not.toBeNull();
    expect(s.ui.anyDialogOpen()).toBe(false);
    expect(s.ui.closeTop()).toBe(true);
    expect(s.ui.linkPick()).toBeNull();
  });
});

describe('TreeStore a committed Compare pick', () => {
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
    model: 'normal/model',
    funding: 'credit',
    createdAt: at,
    updatedAt: at,
  };
  const msg = (id: string, parentId: string | null, seq: number, model: string): ChatNode => ({
    id,
    treeId: 't1',
    branchId: 'trunk',
    parentId,
    seq,
    role: seq % 2 === 0 ? 'user' : 'assistant',
    content: id,
    status: 'complete',
    error: null,
    providerId: 'openrouter',
    model,
    usage: null,
    createdAt: at,
  });

  function open() {
    const s = setup();
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
      nodes: [msg('u1', null, 0, 'normal/model'), msg('a1', 'u1', 1, 'normal/model')],
      links: [],
    });
    s.store.setRoute('t1', 'trunk', null);
    return s;
  }

  it('adds the question and the kept answer as a finished reply, leaving the branch on its route', async () => {
    const s = open();
    const completions = s.store.completions();
    s.api.listTrees.mockClear();
    const branch = { ...trunk, title: 'Light and waves', updatedAt: '2026-10-02T00:00:00.000Z' };
    s.store.applyCommitted({
      userNode: msg('u2', 'a1', 2, 'max/model'),
      assistantNode: { ...msg('a2', 'u2', 3, 'max/model'), content: 'The kept answer' },
      branch,
    });
    expect(s.store.path().map((n) => n.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(s.store.leaf()).toMatchObject({ id: 'a2', model: 'max/model', status: 'complete' });
    expect(s.store.selectedBranch()).toEqual(branch);
    expect(s.store.selectedBranch()?.model).toBe('normal/model');
    expect(s.store.live().size).toBe(0);
    expect(s.store.busy()).toBe(false);
    // Like a finished send: the inspector refreshes and the list re-reads titles.
    expect(s.store.completions()).toBe(completions + 1);
    await Promise.resolve();
    expect(s.api.listTrees).toHaveBeenCalled();
  });

  it("lets go of a message of that branch that couldn't be sent", () => {
    const s = open();
    s.store.unsentDrafts.set(new Map([['trunk', 'Why?']]));
    s.store.applyCommitted({
      userNode: msg('u2', 'a1', 2, 'max/model'),
      assistantNode: msg('a2', 'u2', 3, 'max/model'),
      branch: trunk,
    });
    expect(s.store.unsentDrafts().has('trunk')).toBe(false);
  });
});
