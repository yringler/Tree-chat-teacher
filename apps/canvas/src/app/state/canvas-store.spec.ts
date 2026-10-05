import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import { Router } from '@angular/router';
import type {
  BillingSummary,
  Branch,
  ChatNode,
  ContextPlanResponse,
  MeResponse,
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
    model: 'smart-model',
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
    providers: vi.fn(async () => []),
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
          includedCreditCents: 0,
        },
      } as MeResponse);
      expect(s.store.membershipBlocked()).toBe(false);

      s.store.fail(new ApiError(402, 'membership_required', 'Membership required'));
      expect(s.store.membershipBlocked()).toBe(true);
      expect(s.ui.toasts()).toEqual([]);

      s.store.fail(new ApiError(402, 'payment_required', 'Not enough credit'));
      expect(s.ui.toasts()[0]?.link).toEqual({ label: 'Add credit', href: '/billing' });
      await vi.waitFor(() => expect(s.store.billing()?.availableMicros).toBe(3_000_000));
      // Credit left: the notice can be dismissed.
      expect(s.store.membershipDismissible()).toBe(true);
      s.store.dismissMembershipNotice();
      expect(s.store.membershipBlocked()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('without a membership, the notice shows on load only when no credit can carry on', async () => {
    const inactive = {
      required: true,
      status: 'inactive',
      subscriptionStatus: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      priceCents: 1000,
      includedCreditCents: 0,
    } as const;
    const withCredit = setup();
    await withCredit.store.init({ builtInCredit: true, membership: inactive } as MeResponse);
    expect(withCredit.store.membershipBlocked()).toBe(false);

    const used = setup();
    used.api.billing.mockResolvedValue({ availableMicros: 0 } as BillingSummary);
    await used.store.init({ builtInCredit: true, membership: inactive } as MeResponse);
    expect(used.store.membershipBlocked()).toBe(true);
    expect(used.store.membershipDismissible()).toBe(false);

    const unsold = setup();
    await unsold.store.init({ builtInCredit: false, membership: inactive } as MeResponse);
    expect(unsold.store.membershipBlocked()).toBe(true);
  });
});

describe('modelLabel', () => {
  const entry = (funding: 'own-key' | 'credit', label: string): ProviderInfo => ({
    id: 'openrouter',
    kind: 'openai-compatible',
    label: funding,
    models: [{ id: 'a/smart', label }],
    defaultModel: 'a/smart',
    openModels: true,
    available: true,
    acceptsUserKey: funding === 'own-key',
    keySource: null,
    funding,
  });
  const providers = [entry('own-key', 'Smart'), entry('credit', 'Smart (suggested)')];

  it('labels by route: the same endpoint on the user key or on Tangent credit', () => {
    expect(modelLabel(providers, { providerId: 'openrouter' }, 'a/smart')).toBe('Smart');
    expect(modelLabel(providers, { providerId: 'openrouter', funding: 'credit' }, 'a/smart')).toBe(
      'Smart (suggested)',
    );
    // A reply records no funding; an unlisted model is shortened.
    expect(modelLabel(providers.slice(1), { providerId: 'openrouter' }, 'a/smart')).toBe(
      'Smart (suggested)',
    );
    expect(modelLabel(providers, { providerId: 'openrouter' }, 'vendor/other')).toBe('other');
  });
});
