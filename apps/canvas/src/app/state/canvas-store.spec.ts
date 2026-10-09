import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import { Router } from '@angular/router';
import type {
  BillingSummary,
  Branch,
  ChatNode,
  ContextPlanResponse,
  CreateBranchRequest,
  CreateLinkRequest,
  DeleteBranchResponse,
  MeResponse,
  NodeLink,
  PoolStatusResponse,
  ProviderInfo,
  StreamEvent,
  TreeDetail,
  TreeSummary,
} from '@tangent/shared';
import { ApiClient, ApiError } from '@tangent/web-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasStore, modelLabel } from './canvas-store';
import { UiStore } from './ui-store';

const T = '2026-01-01T00:00:00.000Z';

function branch(id: string, over: Partial<Branch> = {}): Branch {
  return {
    id,
    treeId: 't1',
    parentBranchId: null,
    branchPointNodeId: null,
    contextMode: 'path',
    anchorQuote: null,
    title: id,
    titleSource: 'default',
    isPrivate: false,
    providerId: 'openrouter',
    model: 'max-model',
    funding: 'credit',
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function node(id: string, over: Partial<ChatNode> = {}): ChatNode {
  return {
    id,
    treeId: 't1',
    branchId: 'trunk',
    parentId: null,
    seq: 0,
    role: 'assistant',
    content: '',
    status: 'complete',
    error: null,
    providerId: null,
    model: null,
    usage: null,
    createdAt: T,
    ...over,
  };
}

/** A trunk with one exchange and lane `b` branching off its reply with one of its own. */
function detail(): TreeDetail {
  return {
    tree: {
      id: 't1',
      accountId: 'u_1',
      title: 'Photosynthesis',
      systemPrompt: null,
      trunkBranchId: 'trunk',
      createdAt: T,
      updatedAt: T,
    },
    branches: [branch('trunk'), branch('b', { parentBranchId: 'trunk', branchPointNodeId: 'a1' })],
    nodes: [
      node('u1', { role: 'user', content: 'What is light?' }),
      node('a1', { seq: 1, parentId: 'u1', content: 'A wave.' }),
      node('u2', { seq: 2, parentId: 'a1', branchId: 'b', role: 'user', content: 'And?' }),
      node('a2', { seq: 3, parentId: 'u2', branchId: 'b', content: 'A particle.' }),
    ],
    links: [],
  };
}

const sse = (events: StreamEvent[]): string =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/** A stream response the test drives: `push` more events, then `close`. */
function controlledStream(first: StreamEvent[]) {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      c.enqueue(enc.encode(sse(first)));
    },
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    push: (events: StreamEvent[]) => ctrl.enqueue(enc.encode(sse(events))),
    close: () => ctrl.close(),
  };
}

function fakeApi() {
  return {
    // What a power user without a membership reads after a 402 `membership_required`.
    me: vi.fn(
      async () =>
        ({
          builtInCredit: true,
          membership: {
            required: true,
            status: 'inactive',
            subscriptionStatus: null,
            periodEnd: null,
            cancelAtPeriodEnd: false,
            priceCents: 1000,
          },
          membershipNeededFor: ['own-key'],
        }) as MeResponse,
    ),
    providers: vi.fn(async (): Promise<ProviderInfo[]> => []),
    listTrees: vi.fn(async (): Promise<TreeSummary[]> => []),
    keyStatus: vi.fn(async () => ({ enabled: true, hasKey: false, providers: [] })),
    getTree: vi.fn(async (_id: string) => detail()),
    getContext: vi.fn(
      (_branchId: string, _nodeId: string | null, _resolve: boolean) =>
        new Promise<ContextPlanResponse>(() => undefined),
    ),
    sendMessage: vi.fn(
      async (_b: string, _req: unknown, _signal: AbortSignal): Promise<Response> =>
        controlledStream([]).response,
    ),
    streamNode: vi.fn(
      async (_id: string, _signal: AbortSignal): Promise<Response> => controlledStream([]).response,
    ),
    cancelNode: vi.fn(async (_id: string) => undefined),
    billing: vi.fn(async () => ({ availableMicros: 3_000_000 }) as BillingSummary),
    poolStatus: vi.fn(async () => ({ enabled: false }) as PoolStatusResponse),
    createLink: vi.fn(async (req: CreateLinkRequest) => ({
      link: link('l-new', req.fromNodeId, req.toNodeId, req.note ?? null),
      created: true,
    })),
    updateLink: vi.fn(async (linkId: string, req: { note: string | null }) =>
      link(linkId, 'u1', 'a2', req.note),
    ),
    deleteLink: vi.fn(async (_linkId: string) => undefined),
    deleteBranch: vi.fn(async (branchId: string): Promise<DeleteBranchResponse> => ({
      treeId: 't1',
      branchIds: [branchId],
      nodeIds: ['u2', 'a2'],
    })),
  };
}

function link(id: string, source: string, target: string, note: string | null = null): NodeLink {
  return {
    id,
    treeId: 't1',
    sourceNodeId: source,
    targetNodeId: target,
    note,
    origin: 'user',
    createdAt: T,
    updatedAt: T,
  };
}

function setup() {
  const api = fakeApi();
  const router = { navigate: vi.fn(async (_commands: unknown[], _extras?: unknown) => true) };
  const injector = Injector.create({
    providers: [
      { provide: CanvasStore },
      { provide: UiStore },
      { provide: ApiClient, useValue: api },
      { provide: Router, useValue: router },
    ],
  });
  const store = injector.get(CanvasStore);
  store.detail.set(detail());
  return { store, api, router, ui: injector.get(UiStore) };
}

describe('CanvasStore', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for a lane’s lineage once while the request is out', () => {
    const s = setup();
    void s.store.loadLineage('b');
    void s.store.loadLineage('b');
    expect(s.api.getContext).toHaveBeenCalledTimes(1);
    expect(s.api.getContext).toHaveBeenCalledWith('b', null, false);
  });

  it('does not retry a lineage the server refused', async () => {
    const s = setup();
    s.api.getContext.mockRejectedValue(new Error('500'));
    await s.store.loadLineage('b');
    await s.store.loadLineage('b');
    expect(s.api.getContext).toHaveBeenCalledTimes(1);
    expect(s.store.lineageLoading()).toBeNull();
  });

  it('keeps busyBranches the same set while deltas stream into a busy lane', async () => {
    const s = setup();
    const userNode = node('u3', { seq: 4, parentId: 'a2', branchId: 'b', role: 'user' });
    const reply = node('a3', { seq: 5, parentId: 'u3', branchId: 'b', status: 'streaming' });
    const live = controlledStream([
      {
        type: 'start',
        userNode,
        assistantNode: reply,
        branch: branch('b', { parentBranchId: 'trunk', branchPointNodeId: 'a1' }),
      },
    ]);
    s.api.sendMessage.mockResolvedValue(live.response);
    const sending = s.store.send('b', 'Which one?');
    await vi.waitFor(() => expect(s.store.live().get('a3')).toBeDefined());

    const busy = s.store.busyBranches();
    expect([...busy]).toEqual(['b']);
    live.push([{ type: 'delta', nodeId: 'a3', text: 'Both.' }]);
    await vi.waitFor(() => expect(s.store.live().get('a3')?.content).toBe('Both.'));
    expect(s.store.busyBranches()).toBe(busy);

    live.push([
      {
        type: 'done',
        node: { ...reply, status: 'complete', content: 'Both.' },
        branch: branch('b', { parentBranchId: 'trunk', branchPointNodeId: 'a1' }),
      },
    ]);
    live.close();
    await expect(sending).resolves.toBe(true);
    expect(s.store.busyBranches().size).toBe(0);
  });

  /** createBranch answering lane `c<n>` off the requested message, titled as asked. */
  function lanes(s: ReturnType<typeof setup>) {
    let n = 0;
    const createBranch = vi.fn(async (req: CreateBranchRequest) =>
      branch(`c${++n}`, {
        parentBranchId: 'trunk',
        branchPointNodeId: req.fromNodeId,
        contextMode: req.contextMode ?? 'path',
        title: req.title ?? 'Branch: A wave.',
        titleSource: req.title ? 'user' : 'default',
      }),
    );
    Object.assign(s.api, { createBranch });
    return createBranch;
  }

  it('"Ask about this" opens a path lane quoting the selection, its box asked to take focus', async () => {
    const s = setup();
    const createBranch = lanes(s);
    const go = vi.spyOn(s.store, 'go');
    const before = s.ui.composerFocus();
    const lane = await s.store.createBranch({
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: 'A wave',
    });
    expect(createBranch).toHaveBeenCalledWith({
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: 'A wave',
    });
    expect(go).toHaveBeenCalledWith('c1');
    // The new lane isn't on the canvas yet: the request names it, for its box to take once rendered.
    expect(s.ui.composerFocus()).toBe(before + 1);
    expect(s.ui.composerFocusLane).toBe(lane?.id);
    expect(s.api.sendMessage).not.toHaveBeenCalled();
  });

  it('"Ask your own" opens an untitled path lane and asks the question there', async () => {
    const s = setup();
    const createBranch = lanes(s);
    const go = vi.spyOn(s.store, 'go');
    const lane = await s.store.askFrom('a1', 'Why a wave?');
    expect(lane?.id).toBe('c1');
    expect(createBranch).toHaveBeenCalledWith({
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: null,
    });
    expect(go).toHaveBeenCalledWith('c1');
    await vi.waitFor(() =>
      expect(s.api.sendMessage).toHaveBeenCalledWith(
        'c1',
        { content: 'Why a wave?' },
        expect.any(AbortSignal),
      ),
    );
  });

  it('a fan-out asks every lane; one lane goes untitled, several are named by model and mode', async () => {
    const s = setup();
    const createBranch = lanes(s);
    const variant = {
      providerId: 'openrouter',
      funding: 'credit' as const,
      model: 'max-model',
    };
    await s.store.fanOut({
      fromNodeId: 'a1',
      anchorQuote: null,
      isPrivate: false,
      variants: [{ ...variant, contextMode: 'path' }],
      firstMessage: 'Why?',
    });
    expect(createBranch.mock.calls[0]![0]).not.toHaveProperty('title');

    await s.store.fanOut({
      fromNodeId: 'a1',
      anchorQuote: null,
      isPrivate: false,
      variants: [
        { ...variant, contextMode: 'path' },
        { ...variant, contextMode: 'independent' },
      ],
      firstMessage: '  And how?  ',
    });
    expect(createBranch.mock.calls.slice(1).map(([req]) => req.title)).toEqual([
      'max-model · path',
      'max-model · independent',
    ]);
    await vi.waitFor(() => expect(s.api.sendMessage).toHaveBeenCalledTimes(3));
    expect(s.api.sendMessage.mock.calls.map(([id, req]) => [id, req])).toEqual([
      ['c1', { content: 'Why?' }],
      ['c2', { content: 'And how?' }],
      ['c3', { content: 'And how?' }],
    ]);
  });

  it('a 402 membership_required raises the membership notice, payment_required links to /billing', async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      await s.store.init({
        builtInCredit: true,
        membership: {
          required: true,
          status: 'active',
          subscriptionStatus: 'active',
          periodEnd: null,
          cancelAtPeriodEnd: false,
          priceCents: 1000,
        },
      } as MeResponse);
      expect(s.store.membershipBlocked()).toBe(false);

      s.store.fail(new ApiError(402, 'membership_required', 'Membership required'));
      expect(s.store.membershipBlocked()).toBe(true);
      expect(s.ui.toasts()).toEqual([]);

      s.store.fail(new ApiError(402, 'payment_required', 'Not enough credit'));
      expect(s.ui.toasts()[0]?.link).toEqual({ label: 'Add credit', href: '/billing' });
      await vi.waitFor(() => expect(s.store.account.billing()?.availableMicros).toBe(3_000_000));
      // Credit left: the notice can be dismissed.
      expect(s.store.membershipDismissible()).toBe(true);
      s.store.dismissMembershipNotice();
      expect(s.store.membershipBlocked()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('without a membership, the notice shows on load only when credit can neither be bought nor spent', async () => {
    const inactive = {
      required: true,
      status: 'inactive',
      subscriptionStatus: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      priceCents: 1000,
    } as const;
    const withCredit = setup();
    await withCredit.store.init({ builtInCredit: true, membership: inactive } as MeResponse);
    expect(withCredit.store.membershipBlocked()).toBe(false);

    // An empty balance where top-ups are sold: anyone can buy more, so credit carries on.
    const empty = setup();
    empty.api.billing.mockResolvedValue({
      availableMicros: 0,
      topUpsEnabled: true,
    } as BillingSummary);
    await empty.store.init({ builtInCredit: true, membership: inactive } as MeResponse);
    expect(empty.store.account.creditCarriesOn()).toBe(true);
    expect(empty.store.membershipBlocked()).toBe(false);

    const used = setup();
    used.api.billing.mockResolvedValue({
      availableMicros: 0,
      topUpsEnabled: false,
    } as BillingSummary);
    await used.store.init({ builtInCredit: true, membership: inactive } as MeResponse);
    expect(used.store.membershipBlocked()).toBe(true);
    expect(used.store.membershipDismissible()).toBe(false);

    const unsold = setup();
    await unsold.store.init({ builtInCredit: false, membership: inactive } as MeResponse);
    expect(unsold.store.membershipBlocked()).toBe(true);
  });
});

describe('CanvasStore read-only lanes without a membership', () => {
  const inactive = {
    required: true,
    status: 'inactive',
    subscriptionStatus: 'canceled',
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
  } as const;
  const credit: ProviderInfo = {
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'Tangent credit',
    models: [{ id: 'max-model', label: 'Max' }],
    defaultModel: 'max-model',
    openModels: true,
    available: true,
    acceptsUserKey: false,
    keySource: 'server',
    funding: 'credit',
  };

  /** The trunk on the user's own key, lane `b` on Tangent credit. */
  function ownKeyTrunk(): TreeDetail {
    const d = detail();
    return {
      ...d,
      branches: d.branches.map((b) => (b.id === 'trunk' ? { ...b, funding: 'own-key' } : b)),
    };
  }

  it('a tangent of a locked lane opens no lane on its route; one already followed still opens', async () => {
    const s = setup();
    s.api.providers.mockResolvedValue([credit]);
    await s.store.init({
      builtInCredit: true,
      membership: inactive,
      membershipNeededFor: ['own-key'],
    } as MeResponse);
    s.store.detail.set(ownKeyTrunk());
    const createBranch = vi.fn(async (req: CreateBranchRequest) =>
      branch('new', { title: req.title ?? '' }),
    );
    Object.assign(s.api, { createBranch });
    await expect(s.store.followTangent('a1', 'Waves in water')).resolves.toBeNull();
    expect(createBranch).not.toHaveBeenCalled();
    expect(s.api.sendMessage).not.toHaveBeenCalled();
    // Lane `b` already follows a1 under its title: it just opens.
    await expect(s.store.followTangent('a1', 'b')).resolves.toMatchObject({ id: 'b' });
  });

  it('a 402 membership_required locks own-key lanes and re-reads me', async () => {
    const s = setup();
    await s.store.init({
      builtInCredit: true,
      membership: { ...inactive, required: false },
      membershipNeededFor: [],
    } as unknown as MeResponse);
    s.store.detail.set(ownKeyTrunk());
    const trunk = s.store.detail()!.branches[0]!;
    expect(s.store.account.routeLocked(trunk)).toBe(false);
    s.api.me.mockResolvedValue({
      builtInCredit: true,
      membership: inactive,
      membershipNeededFor: ['own-key'],
    } as MeResponse);
    s.store.fail(new ApiError(402, 'membership_required', 'Membership required'));
    expect(s.store.account.routeLocked(trunk)).toBe(true);
    await vi.waitFor(() => expect(s.api.me).toHaveBeenCalled());
    await vi.waitFor(() => expect(s.store.account.membershipNeededFor()).toEqual(['own-key']));
  });

  it('"Continue with Tangent credit" moves a locked lane onto credit', async () => {
    const s = setup();
    s.api.providers.mockResolvedValue([credit]);
    await s.store.init({
      builtInCredit: true,
      membership: inactive,
      membershipNeededFor: ['own-key'],
    } as MeResponse);
    s.store.detail.set(ownKeyTrunk());
    const updateBranch = vi.fn(async (id: string, req: object) => ({
      ...ownKeyTrunk().branches.find((b) => b.id === id)!,
      ...req,
    }));
    (s.api as unknown as { updateBranch: typeof updateBranch }).updateBranch = updateBranch;
    await expect(s.store.switchToCredit('trunk')).resolves.toBe(true);
    expect(updateBranch).toHaveBeenCalledWith('trunk', {
      providerId: 'openrouter',
      funding: 'credit',
      model: 'max-model',
    });
    expect(s.store.account.routeLocked(s.store.detail()!.branches[0]!)).toBe(false);
  });

  it('a lane on the own key with no key here: a refused send waits for credit, and keeps its text', async () => {
    const s = setup();
    const noKey: ProviderInfo = {
      ...credit,
      label: 'OpenRouter',
      available: false,
      acceptsUserKey: true,
      keySource: null,
      funding: 'own-key',
    };
    s.api.providers.mockResolvedValue([noKey, credit]);
    await s.store.init({
      builtInCredit: true,
      membership: { ...inactive, status: 'active' },
      membershipNeededFor: ['own-key'],
    } as MeResponse);
    s.store.detail.set(ownKeyTrunk());
    expect(s.store.account.keyMissing(s.store.detail()!.branches[0]!)).toBe(true);
    const updateBranch = vi.fn(async (id: string, req: object) => ({
      ...ownKeyTrunk().branches.find((b) => b.id === id)!,
      ...req,
    }));
    (s.api as unknown as { updateBranch: typeof updateBranch }).updateBranch = updateBranch;
    s.api.sendMessage.mockRejectedValueOnce(new ApiError(401, 'key_required', 'Add your key'));

    await expect(s.store.send('trunk', 'Why green?')).resolves.toBe(false);
    expect(s.ui.keysOpen()).toBe(true);
    expect(s.store.blockedBranch()?.id).toBe('trunk');
    expect(s.store.unsentDrafts().get('trunk')).toBe('Why green?');
    expect(s.ui.composerSent()).toBeNull();

    await expect(s.store.resumeOnCredit()).resolves.toBe(true);
    expect(updateBranch).toHaveBeenCalledWith('trunk', {
      providerId: 'openrouter',
      funding: 'credit',
      model: 'max-model',
    });
    expect(s.api.sendMessage).toHaveBeenLastCalledWith(
      'trunk',
      { content: 'Why green?' },
      expect.any(AbortSignal),
    );
    expect(s.store.blockedSends()).toEqual([]);
    expect(s.store.unsentDrafts().has('trunk')).toBe(false);
    expect(s.ui.keysOpen()).toBe(false);
  });
});

describe('modelLabel', () => {
  const entry = (funding: 'own-key' | 'credit', label: string): ProviderInfo => ({
    id: 'openrouter',
    kind: 'openai-compatible',
    label: funding,
    models: [{ id: 'a/max', label }],
    defaultModel: 'a/max',
    openModels: true,
    available: true,
    acceptsUserKey: funding === 'own-key',
    keySource: null,
    funding,
  });
  const providers = [entry('own-key', 'Max'), entry('credit', 'Max (suggested)')];

  it('labels by route: the same endpoint on the user key or on Tangent credit', () => {
    expect(modelLabel(providers, { providerId: 'openrouter' }, 'a/max')).toBe('Max');
    expect(modelLabel(providers, { providerId: 'openrouter', funding: 'credit' }, 'a/max')).toBe(
      'Max (suggested)',
    );
    // A reply records no funding; an unlisted model is shortened.
    expect(modelLabel(providers.slice(1), { providerId: 'openrouter' }, 'a/max')).toBe(
      'Max (suggested)',
    );
    expect(modelLabel(providers, { providerId: 'openrouter' }, 'vendor/other')).toBe('other');
  });
});

describe('CanvasStore links between messages', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The store with links: trunk's reply a1 ↔ lane b's reply a2, and u1 ↔ a1 on the trunk. */
  function linked() {
    const s = setup();
    s.store.detail.update((d) =>
      d ? { ...d, links: [link('l1', 'a1', 'a2', 'Same idea'), link('l2', 'u1', 'a1')] } : d,
    );
    s.store.setRoute('t1', 'trunk', null);
    return s;
  }

  it('edits a note and removes a link (closing its popover)', async () => {
    const s = linked();
    await expect(s.store.updateLinkNote('l1', null)).resolves.toBe(true);
    expect(s.api.updateLink).toHaveBeenCalledWith('l1', { note: null });
    expect(s.store.links().find((l) => l.id === 'l1')?.note).toBeNull();

    s.ui.linkPopover.set({ linkId: 'l1' });
    await expect(s.store.deleteLink('l1')).resolves.toBe(true);
    expect(s.api.deleteLink).toHaveBeenCalledWith('l1');
    expect(s.store.links().map((l) => l.id)).toEqual(['l2']);
    expect(s.ui.linkPopover()).toBeNull();
    expect(s.ui.toasts().at(-1)?.text).toBe('Link removed');
  });

  it('a link already removed elsewhere (404) goes here too, popover and all', async () => {
    const s = linked();
    s.api.updateLink.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Link not found'));
    await expect(s.store.updateLinkNote('l2', 'Why')).resolves.toBe(false);
    expect(s.store.links().map((l) => l.id)).toEqual(['l1']);

    s.ui.linkPopover.set({ linkId: 'l1' });
    s.api.deleteLink.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Link not found'));
    await expect(s.store.deleteLink('l1')).resolves.toBe(true);
    expect(s.store.links()).toEqual([]);
    expect(s.ui.linkPopover()).toBeNull();
    expect(s.ui.toasts().map((t) => t.text)).toEqual([
      'That link was already removed',
      'That link was already removed',
    ]);
  });

  it('deleting a lane drops the links touching its messages, and linking from them', async () => {
    const s = linked();
    s.ui.linkPick.set({ fromNodeId: 'a2' });
    s.ui.linkPopover.set({ linkId: 'l1' });
    s.ui.linkReturn.set({ branchId: 'trunk', nodeId: 'a1', label: 'trunk', toBranchId: 'b' });
    await expect(s.store.deleteBranch('b')).resolves.toBe(true);
    expect(s.store.links().map((l) => l.id)).toEqual(['l2']);
    expect(s.store.linksByNode().has('a2')).toBe(false);
    expect(s.ui.linkPick()).toBeNull();
    expect(s.ui.linkPopover()).toBeNull();
    expect(s.ui.linkReturn()).toBeNull();
  });

  it('a deleted lane leaves linking from elsewhere alone', async () => {
    const s = linked();
    s.ui.linkPick.set({ fromNodeId: 'u1' });
    await s.store.deleteBranch('b');
    expect(s.ui.linkPick()).toEqual({ fromNodeId: 'u1' });
  });

  it('openNode unfolds the lanes on the way, goes to the card and remembers the way back', () => {
    const s = linked();
    s.ui.toggleCollapsed('b');
    s.ui.linkPopover.set({ linkId: 'l1' });
    expect(s.store.openNode('a2', 'a1')).toBe(true);
    expect(s.ui.collapsed().has('b')).toBe(false);
    expect(s.router.navigate).toHaveBeenLastCalledWith(['/t', 't1', 'b', 'b'], {
      queryParams: { m: 'a2' },
      replaceUrl: false,
    });
    expect(s.ui.linkReturn()).toEqual({
      branchId: 'trunk',
      nodeId: 'a1',
      label: 'trunk',
      toBranchId: 'b',
    });
    expect(s.ui.linkPopover()).toBeNull();

    // Arriving there keeps it; coming back to where it was followed from clears it.
    s.store.setRoute('t1', 'b', 'a2');
    expect(s.ui.linkReturn()).not.toBeNull();
    s.store.goBackFromLink();
    expect(s.router.navigate).toHaveBeenLastCalledWith(['/t', 't1', 'b', 'trunk'], {
      queryParams: { m: 'a1' },
      replaceUrl: false,
    });
    expect(s.ui.linkReturn()).toBeNull();
  });

  it('the way back leads to the lane of the message the link was followed from', () => {
    const s = linked();
    // The selected lane is the trunk, but the link was followed from a2's end (a glyph's popover).
    expect(s.store.openNode('u1', 'a2')).toBe(true);
    expect(s.ui.linkReturn()).toEqual({
      branchId: 'b',
      nodeId: 'a2',
      label: 'b',
      toBranchId: 'trunk',
    });
  });

  it('openNode refuses a message that is not in the tree', () => {
    const s = linked();
    expect(s.store.openNode('nope')).toBe(false);
    expect(s.router.navigate).not.toHaveBeenCalled();
    expect(s.ui.linkReturn()).toBeNull();
  });

  it('opening another tree ends every link interaction', () => {
    const s = linked();
    s.ui.linkPick.set({ fromNodeId: 'u1' });
    s.ui.linkReturn.set({ branchId: 'trunk', nodeId: null, label: 'trunk', toBranchId: 'b' });
    s.store.setRoute('t2', null, null);
    expect(s.ui.linkPick()).toBeNull();
    expect(s.ui.linkReturn()).toBeNull();
  });
});
