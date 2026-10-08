import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import { Router } from '@angular/router';
import type {
  BillingSummary,
  Branch,
  CandidateEvent,
  CandidateRequest,
  CommitCandidateResponse,
  PoolBlockDetails,
  PoolStatusResponse,
  ChatNode,
  CreateBranchRequest,
  CreateLinkRequest,
  NodeLink,
  ProviderInfo,
  StreamEvent,
  TreeBackup,
  TreeBackupInput,
  TreeDetail,
  TreeSummary,
} from '@tangent/shared';
import { POOL_NOTICE_VERSION } from '@tangent/shared';
import { ApiClient, ApiError, SAVE_FILE } from '@tangent/web-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStore } from './account-store';
import { COMPARE_OUT_OF_DATE_MESSAGE, LessonStore, OUT_OF_CREDIT_MESSAGE } from './lesson-store';
import { PaymentStore } from './payment-store';
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
    model: 'normal-model',
    funding: 'own-key',
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

function link(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  note: string | null = null,
): NodeLink {
  return {
    id,
    treeId: 't1',
    sourceNodeId,
    targetNodeId,
    note,
    origin: 'user',
    createdAt: T,
    updatedAt: T,
  };
}

function detail(
  nodes: ChatNode[] = [],
  branches: Branch[] = [branch('trunk')],
  links: NodeLink[] = [],
): TreeDetail {
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
    branches,
    nodes,
    links,
  };
}

const sse = (events: StreamEvent[]): string =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/** A stream response that emits `events` and then closes. */
function stream(events: StreamEvent[]): Response {
  return new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } });
}

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

const PROVIDER: ProviderInfo = {
  id: 'openrouter',
  kind: 'openai-compatible',
  label: 'Tangent',
  models: [
    { id: 'normal-model', label: 'Normal', tier: 'normal' },
    { id: 'max-model', label: 'Max', tier: 'max', usageFactor: 3 },
  ],
  defaultModel: 'normal-model',
  openModels: false,
  available: true,
  acceptsUserKey: false,
  keySource: 'server',
};

const BILLING: BillingSummary = {
  enabled: true,
  membership: {
    required: false,
    status: 'inactive',
    subscriptionStatus: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
    includedCreditCents: 0,
  },
  builtInCredit: true,
  currency: 'usd',
  balanceMicros: 0,
  heldMicros: 0,
  availableMicros: 0,
  markupBps: 0,
  openRouterFeeBps: 0,
  minTopUpCents: 500,
  maxTopUpCents: 50_000,
};

function fakeApi() {
  return {
    providers: vi.fn(async () => [PROVIDER]),
    listTrees: vi.fn(async (): Promise<TreeSummary[]> => []),
    getTree: vi.fn(async (_id: string) => detail()),
    createTree: vi.fn(async (_req: unknown) => detail()),
    deleteTree: vi.fn(async (_id: string) => undefined),
    deleteBranch: vi.fn(async (_id: string) => ({
      treeId: 't1',
      branchIds: ['side', 'deeper'],
      nodeIds: ['u2', 'a2', 'u3'],
    })),
    createBranch: vi.fn(async (req: CreateBranchRequest) =>
      branch('side', {
        parentBranchId: 'trunk',
        branchPointNodeId: req.fromNodeId,
        anchorQuote: req.anchorQuote ?? null,
        model: req.model ?? 'normal-model',
      }),
    ),
    updateBranch: vi.fn(async (id: string, req: { model?: string }) =>
      branch(id, { model: req.model ?? 'normal-model' }),
    ),
    sendMessage: vi.fn(async (_b: string, _req: unknown, _signal: AbortSignal): Promise<Response> =>
      stream([]),
    ),
    streamNode: vi.fn(async (_id: string, _signal: AbortSignal): Promise<Response> => stream([])),
    cancelNode: vi.fn(async (_id: string) => undefined),
    billing: vi.fn(async () => BILLING),
    keyStatus: vi.fn(async () => ({ enabled: true, hasKey: false, providers: [] })),
    poolStatus: vi.fn(async () => POOL_STATUS),
    poolMe: vi.fn(async () => {
      throw new Error('not needed');
    }),
    poolConsent: vi.fn(async (version: number) => ({
      version,
      acknowledgedAt: T,
    })),
    backup: vi.fn(async (_id: string): Promise<TreeBackup> => backupOf(detail())),
    importBackup: vi.fn(async (_backup: TreeBackupInput) => detail()),
    createLink: vi.fn(async (req: CreateLinkRequest) => ({
      link: link('l-new', req.fromNodeId, req.toNodeId, req.note ?? null),
      created: true,
    })),
    updateLink: vi.fn(async (id: string, req: { note: string | null }) =>
      link(id, 'a1', 'a2', req.note),
    ),
    deleteLink: vi.fn(async (_id: string) => undefined),
    streamCandidate: vi.fn(
      async (_b: string, req: CandidateRequest, _signal: AbortSignal): Promise<Response> =>
        candidateStream(req.model),
    ),
    commitCandidate: vi.fn(
      async (_b: string, _candidateId: string): Promise<CommitCandidateResponse> => {
        throw new Error('not needed');
      },
    ),
  };
}

/** A finished candidate answer from `model` (Compare). */
function candidateStream(model: string): Response {
  const events: CandidateEvent[] = [
    { type: 'delta', text: `Answer from ${model}.` },
    {
      type: 'done',
      candidateId: `cand-${model}`,
      providerId: 'openrouter',
      funding: 'credit',
      model,
      usage: null,
      sources: null,
      expiresAt: T,
    },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function backupOf(d: TreeDetail): TreeBackup {
  return {
    format: 'tangent-tree-backup',
    version: 1,
    exportedAt: T,
    tree: d.tree,
    branches: d.branches,
    nodes: d.nodes,
  };
}

const POOL_STATUS: PoolStatusResponse = {
  enabled: true,
  availableMicros: 0,
  sessionsRemaining: 0,
  model: { id: 'lite-model', label: 'Lite' },
  week: { start: T, exchanges: 0, learners: 0 },
  revenueShareBps: 2000,
};

function setup() {
  const api = fakeApi();
  const router = { navigate: vi.fn(async (_commands: unknown[], _extras?: unknown) => true) };
  const saveFile = vi.fn((_name: string, _blob: Blob) => undefined);
  const injector = Injector.create({
    providers: [
      { provide: LessonStore },
      { provide: UiStore },
      { provide: AccountStore },
      { provide: PaymentStore },
      { provide: ApiClient, useValue: api },
      { provide: Router, useValue: router },
      { provide: SAVE_FILE, useValue: saveFile },
    ],
  });
  const store = injector.get(LessonStore);
  const ui = injector.get(UiStore);
  return { store, ui, api, router, injector, saveFile };
}

/** Opens lesson t1 at `branchId` and waits for it to load. */
async function open(
  s: ReturnType<typeof setup>,
  d: TreeDetail,
  branchId: string | null = null,
): Promise<void> {
  s.api.getTree.mockResolvedValue(d);
  s.store.setRoute('t1', branchId, null);
  await vi.waitFor(() => expect(s.store.detail()).not.toBeNull());
}

const userNode = node('u1', { role: 'user', content: 'What is light?' });
const replyNode = node('a1', { seq: 1, parentId: 'u1', status: 'streaming' });

describe('LessonStore', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('loads providers and exposes the Normal/Max models', async () => {
    const s = setup();
    await s.store.init();
    expect(s.store.models().map((m) => m.label)).toEqual(['Normal', 'Max']);
    expect(s.store.defaultModel()).toBe('normal-model');
    expect(s.store.treesLoaded()).toBe(true);
  });

  it('applies start, status, delta and done events to the open lesson', async () => {
    const s = setup();
    await open(s, detail());
    const live = controlledStream([
      { type: 'start', userNode, assistantNode: replyNode, branch: branch('trunk') },
      { type: 'status', message: 'Thinking…' },
    ]);
    s.api.sendMessage.mockResolvedValue(live.response);
    const sending = s.store.send('trunk', 'What is light?');
    expect(s.store.busy()).toBe(true);
    // The composer keeps the text until the message is in the lesson.
    expect(s.ui.composerSent()).toBeNull();

    await vi.waitFor(() => expect(s.store.live().get('a1')?.status).toBe('Thinking…'));
    expect(s.ui.composerSent()).toEqual({ seq: 1, text: 'What is light?' });
    expect(s.store.streamingNode()?.id).toBe('a1');
    expect(s.store.sendingBranchId()).toBeNull();

    live.push([
      { type: 'delta', nodeId: 'a1', text: 'Light is ' },
      { type: 'delta', nodeId: 'a1', text: 'a wave.' },
    ]);
    await vi.waitFor(() => expect(s.store.live().get('a1')?.content).toBe('Light is a wave.'));
    expect(s.store.live().get('a1')?.status).toBeNull();

    live.push([
      {
        type: 'done',
        node: { ...replyNode, status: 'complete', content: 'Light is a wave.' },
        branch: branch('trunk', { title: 'Light' }),
      },
    ]);
    live.close();
    await expect(sending).resolves.toBe(true);

    expect(s.api.sendMessage).toHaveBeenCalledWith(
      'trunk',
      { content: 'What is light?' },
      expect.any(AbortSignal),
    );
    expect(s.store.path().map((n) => [n.id, n.status, n.content])).toEqual([
      ['u1', 'complete', 'What is light?'],
      ['a1', 'complete', 'Light is a wave.'],
    ]);
    expect(s.store.selectedBranch()?.title).toBe('Light');
    expect(s.store.live().size).toBe(0);
    expect(s.store.busy()).toBe(false);
    // The balance and the lesson list are refreshed after a reply.
    await vi.waitFor(() => expect(s.api.billing).toHaveBeenCalled());
    expect(s.api.listTrees).toHaveBeenCalled();
  });

  it('Stop cancels on the server; the closing error event ends the reply', async () => {
    const s = setup();
    await open(s, detail());
    const live = controlledStream([
      { type: 'start', userNode, assistantNode: replyNode, branch: branch('trunk') },
      { type: 'delta', nodeId: 'a1', text: 'Li' },
    ]);
    s.api.sendMessage.mockResolvedValue(live.response);
    s.api.cancelNode.mockImplementation(async (id: string) => {
      live.push([
        {
          type: 'error',
          nodeId: id,
          message: 'Cancelled',
          node: { ...replyNode, status: 'error', error: 'Cancelled', content: 'Li' },
        },
      ]);
      live.close();
    });
    const sending = s.store.send('trunk', 'What is light?');
    await vi.waitFor(() => expect(s.store.live().get('a1')?.content).toBe('Li'));

    await s.store.cancel('a1');
    await expect(sending).resolves.toBe(true);

    expect(s.api.cancelNode).toHaveBeenCalledWith('a1');
    expect(s.api.streamNode).not.toHaveBeenCalled();
    const stopped = s.store.index()?.nodes.get('a1');
    expect(stopped?.status).toBe('error');
    expect(stopped?.error).toBe('Cancelled');
    expect(stopped?.content).toBe('Li');
    expect(s.store.streamingNode()).toBeNull();
    expect(s.store.busy()).toBe(false);
  });

  it('reconnects when the stream drops and finishes from the snapshot', async () => {
    const s = setup();
    await open(s, detail());
    s.api.sendMessage.mockResolvedValue(
      stream([{ type: 'start', userNode, assistantNode: replyNode, branch: branch('trunk') }]),
    );
    s.api.streamNode.mockResolvedValue(
      stream([
        { type: 'snapshot', node: { ...replyNode, content: 'Light is' } },
        { type: 'delta', nodeId: 'a1', text: ' fast.' },
        {
          type: 'done',
          node: { ...replyNode, status: 'complete', content: 'Light is fast.' },
          branch: branch('trunk'),
        },
      ]),
    );
    await expect(s.store.send('trunk', 'What is light?')).resolves.toBe(true);
    expect(s.api.streamNode).toHaveBeenCalledWith('a1', expect.any(AbortSignal));
    expect(s.store.index()?.nodes.get('a1')?.content).toBe('Light is fast.');
    expect(s.store.live().size).toBe(0);
  });

  it('marks the reply failed when the connection cannot be recovered', async () => {
    const s = setup();
    await open(s, detail());
    s.api.sendMessage.mockResolvedValue(
      stream([{ type: 'start', userNode, assistantNode: replyNode, branch: branch('trunk') }]),
    );
    s.api.streamNode.mockRejectedValue(new ApiError(404, 'not_found', 'gone'));
    await s.store.send('trunk', 'What is light?');
    expect(s.store.index()?.nodes.get('a1')?.status).toBe('error');
    expect(s.store.busy()).toBe(false);
    expect(s.ui.toasts().at(-1)?.text).toContain('Lost the connection');
  });

  it('re-attaches to a reply still generating when a lesson opens', async () => {
    const s = setup();
    s.api.streamNode.mockResolvedValue(
      stream([
        { type: 'snapshot', node: { ...replyNode, content: 'Half' } },
        {
          type: 'done',
          node: { ...replyNode, status: 'complete', content: 'Half done.' },
          branch: branch('trunk'),
        },
      ]),
    );
    await open(s, detail([userNode, replyNode]));
    await vi.waitFor(() => expect(s.store.index()?.nodes.get('a1')?.content).toBe('Half done.'));
    expect(s.api.streamNode).toHaveBeenCalledWith('a1', expect.any(AbortSignal));
    expect(s.store.live().size).toBe(0);
  });

  it('402 on send: offers billing with a toast and keeps the message', async () => {
    const s = setup();
    await open(s, detail());
    s.api.sendMessage.mockRejectedValue(
      new ApiError(402, 'payment_required', 'Your balance is too low'),
    );
    await expect(s.store.send('trunk', 'What is light?')).resolves.toBe(false);

    expect(s.router.navigate).toHaveBeenCalledWith(['/billing']);
    expect(s.ui.toasts().at(-1)).toMatchObject({ kind: 'error', text: OUT_OF_CREDIT_MESSAGE });
    expect(s.store.unsentDraft()).toEqual({ branchId: 'trunk', text: 'What is light?' });
    expect(s.store.busy()).toBe(false);
    expect(s.store.path()).toEqual([]);
    await vi.waitFor(() => expect(s.api.billing).toHaveBeenCalled());

    // Sending again (after a top-up) clears the kept draft.
    s.api.sendMessage.mockResolvedValue(stream([]));
    await s.store.send('trunk', 'What is light?');
    expect(s.store.unsentDraft()).toBeNull();
  });

  it('401 key_required on send: opens the payment dialog and keeps the message', async () => {
    const s = setup();
    await open(s, detail());
    s.api.sendMessage.mockRejectedValue(
      new ApiError(
        401,
        'key_required',
        'Add your OpenRouter API key to continue this conversation.',
      ),
    );
    await expect(s.store.send('trunk', 'What is light?')).resolves.toBe(false);

    expect(s.ui.accessOpen()).toBe(true);
    expect(s.ui.toasts().at(-1)).toMatchObject({ kind: 'error' });
    expect(s.router.navigate).not.toHaveBeenCalledWith(['/billing']);
    expect(s.store.unsentDraft()).toEqual({
      branchId: 'trunk',
      text: 'What is light?',
      needsKey: true,
    });
    await vi.waitFor(() => expect(s.api.keyStatus).toHaveBeenCalled());

    // A way to pay settled in the dialog: the refused message goes, once.
    s.api.sendMessage.mockRejectedValue(new ApiError(409, 'conflict', 'Still generating'));
    expect(s.store.resumeUnsent()).toBe(true);
    await vi.waitFor(() => expect(s.api.sendMessage).toHaveBeenCalledTimes(2));
    expect(s.api.sendMessage).toHaveBeenLastCalledWith(
      'trunk',
      { content: 'What is light?' },
      expect.any(AbortSignal),
    );
    // Refused again for another reason: kept, but no longer waiting on a key.
    await vi.waitFor(() =>
      expect(s.store.unsentDraft()).toEqual({ branchId: 'trunk', text: 'What is light?' }),
    );
    expect(s.store.resumeUnsent()).toBe(false);
  });

  it('402 membership_required on send: locks the own key, no toast, keeps the message', async () => {
    const s = setup();
    const account = s.injector.get(AccountStore);
    account.setMembership({ ...BILLING.membership, required: true, status: 'active' });
    s.api.billing.mockResolvedValue({
      ...BILLING,
      membership: { ...BILLING.membership, required: true, status: 'inactive' },
    });
    await open(s, detail());
    s.api.sendMessage.mockRejectedValue(
      new ApiError(402, 'membership_required', 'A membership is required'),
    );
    await expect(s.store.send('trunk', 'What is light?')).resolves.toBe(false);

    expect(account.membershipBlocked()).toBe(true);
    expect(s.router.navigate).not.toHaveBeenCalledWith(['/billing']);
    expect(s.ui.toasts()).toEqual([]);
    expect(s.store.unsentDraft()).toEqual({ branchId: 'trunk', text: 'What is light?' });
    await vi.waitFor(() => expect(account.billing()?.membership.status).toBe('inactive'));
    expect(account.membershipBlocked()).toBe(true);
  });

  it('402 pool_empty on send: the inline empty state, no toast, no navigation, message kept', async () => {
    const s = setup();
    await open(s, detail());
    const empty: PoolBlockDetails = {
      reason: 'empty',
      limit: null,
      resetAt: null,
    };
    s.api.sendMessage.mockRejectedValue(
      new ApiError(402, 'pool_empty', 'The open pool is empty', empty),
    );
    await expect(s.store.send('trunk', 'What is light?')).resolves.toBe(false);

    expect(s.store.poolBlock()).toEqual({ kind: 'empty', details: empty, branchId: 'trunk' });
    expect(s.ui.toasts()).toEqual([]);
    expect(s.router.navigate).not.toHaveBeenCalled();
    expect(s.store.unsentDraft()).toEqual({ branchId: 'trunk', text: 'What is light?' });
    // Refused before anything was written: no message in the lesson.
    expect(s.store.path()).toEqual([]);
    expect(s.store.busy()).toBe(false);
    // The meter is re-read, so the header shows the empty pool too.
    await vi.waitFor(() => expect(s.api.poolStatus).toHaveBeenCalled());
  });

  it('429 pool_cap_reached on send: the inline cap state with its limit and reset', async () => {
    const s = setup();
    await open(s, detail());
    const cap: PoolBlockDetails = {
      reason: 'cap_requests',
      limit: 30,
      resetAt: '2026-01-02T00:00:00.000Z',
    };
    s.api.sendMessage.mockRejectedValue(
      new ApiError(429, 'pool_cap_reached', "You've reached today's pool limit", cap),
    );
    await expect(s.store.send('trunk', 'What is light?')).resolves.toBe(false);

    expect(s.store.poolBlock()).toEqual({ kind: 'cap', details: cap, branchId: 'trunk' });
    expect(s.store.poolBlock()?.details).toMatchObject({ limit: 30, resetAt: cap.resetAt });
    expect(s.ui.toasts()).toEqual([]);
    expect(s.router.navigate).not.toHaveBeenCalled();
    expect(s.store.unsentDraft()?.text).toBe('What is light?');

    // Sending again clears the state; dismissing does too.
    s.api.sendMessage.mockResolvedValue(stream([]));
    await s.store.send('trunk', 'What is light?');
    expect(s.store.poolBlock()).toBeNull();
    s.store.poolBlock.set({ kind: 'cap', details: cap, branchId: 'trunk' });
    s.store.dismissPoolBlock();
    expect(s.store.poolBlock()).toBeNull();
  });

  it('403 pool_unavailable (verify) on send: opens the human check and keeps the message', async () => {
    const s = setup();
    await open(s, detail());
    s.api.sendMessage.mockRejectedValue(
      new ApiError(403, 'pool_unavailable', 'Complete the quick human check', {
        reason: 'verify',
        limit: null,
        resetAt: null,
      }),
    );
    await expect(s.store.send('trunk', 'What is light?')).resolves.toBe(false);
    expect(s.ui.poolVerifyOpen()).toBe(true);
    expect(s.ui.toasts()).toEqual([]);
    expect(s.store.poolBlock()).toBeNull();
    expect(s.store.unsentDraft()?.text).toBe('What is light?');
  });

  it('403 pool_consent_required on send: opens the notice, then acknowledging records it and resends', async () => {
    const s = setup();
    await open(s, detail());
    s.api.sendMessage.mockRejectedValueOnce(
      new ApiError(403, 'pool_consent_required', 'Read the notice', null, {
        currentVersion: POOL_NOTICE_VERSION,
      }),
    );
    await expect(s.store.send('trunk', 'What is light?')).resolves.toBe(false);
    expect(s.ui.poolConsentVersion()).toBe(POOL_NOTICE_VERSION);
    expect(s.ui.poolVerifyOpen()).toBe(false);
    expect(s.ui.toasts()).toEqual([]);
    expect(s.store.unsentDraft()).toEqual({ branchId: 'trunk', text: 'What is light?' });

    s.api.sendMessage.mockResolvedValueOnce(stream([]));
    await expect(s.store.acknowledgePoolNotice()).resolves.toBe(true);
    expect(s.api.poolConsent).toHaveBeenCalledWith(POOL_NOTICE_VERSION);
    expect(s.ui.poolConsentVersion()).toBeNull();
    await vi.waitFor(() => expect(s.api.sendMessage).toHaveBeenCalledTimes(2));
    expect(s.api.sendMessage.mock.calls[1]!.slice(0, 2)).toEqual([
      'trunk',
      { content: 'What is light?' },
    ]);
  });

  it('a notice that changed meanwhile (409) keeps the dialog open and says to reload', async () => {
    const s = setup();
    await open(s, detail());
    s.ui.poolConsentVersion.set(POOL_NOTICE_VERSION);
    s.api.poolConsent.mockRejectedValueOnce(new ApiError(409, 'conflict', 'Changed'));
    await expect(s.store.acknowledgePoolNotice()).resolves.toBe(false);
    expect(s.ui.poolConsentVersion()).toBe(POOL_NOTICE_VERSION);
    expect(s.ui.toasts().at(-1)?.text).toMatch(/Reload the page/);
    expect(s.api.sendMessage).not.toHaveBeenCalled();
  });

  it('never acknowledges a newer notice version than the text this build shows', async () => {
    const s = setup();
    await open(s, detail());
    const newer = POOL_NOTICE_VERSION + 1;
    s.api.sendMessage.mockRejectedValueOnce(
      new ApiError(403, 'pool_consent_required', 'Read the notice', null, {
        currentVersion: newer,
      }),
    );
    await expect(s.store.send('trunk', 'What is light?')).resolves.toBe(false);
    expect(s.ui.poolConsentVersion()).toBe(newer);

    await expect(s.store.acknowledgePoolNotice()).resolves.toBe(false);
    expect(s.api.poolConsent).not.toHaveBeenCalled();
    expect(s.ui.poolConsentVersion()).toBe(newer);
    expect(s.ui.toasts().at(-1)?.text).toMatch(/Reload the page/);
    expect(s.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('other pool_unavailable reasons are reported as a toast', async () => {
    const s = setup();
    await open(s, detail());
    s.api.sendMessage.mockRejectedValue(
      new ApiError(403, 'pool_unavailable', 'Open pool access is suspended for this account'),
    );
    await s.store.send('trunk', 'What is light?');
    expect(s.ui.poolVerifyOpen()).toBe(false);
    expect(s.ui.toasts().at(-1)).toMatchObject({
      kind: 'error',
      text: 'Open pool access is suspended for this account',
    });
  });

  it('402 on the first message of a new lesson goes to billing too', async () => {
    const s = setup();
    await s.store.init();
    s.api.sendMessage.mockRejectedValue(new ApiError(402, 'payment_required', 'Too low'));
    await expect(s.store.startLesson('max-model', '  Teach me fractions ')).resolves.toBe(true);

    expect(s.api.createTree).toHaveBeenCalledWith({
      providerId: 'openrouter',
      model: 'max-model',
    });
    expect(s.router.navigate).toHaveBeenCalledWith(['/t', 't1']);
    await vi.waitFor(() => expect(s.router.navigate).toHaveBeenLastCalledWith(['/billing']));
    expect(s.api.sendMessage).toHaveBeenCalledWith(
      'trunk',
      { content: 'Teach me fractions' },
      expect.any(AbortSignal),
    );
    expect(s.store.trees().map((t) => t.id)).toEqual(['t1']);
  });

  it('other errors are shown as toasts without leaving the lesson', async () => {
    const s = setup();
    await open(s, detail());
    s.api.sendMessage.mockRejectedValue(new ApiError(409, 'conflict', 'Still generating'));
    await expect(s.store.send('trunk', 'Hi')).resolves.toBe(false);
    expect(s.router.navigate).not.toHaveBeenCalled();
    expect(s.ui.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Still generating' });
    // Nothing was written: the message is offered back, not lost.
    expect(s.store.unsentDraft()).toEqual({ branchId: 'trunk', text: 'Hi' });
    expect(s.ui.composerSent()).toBeNull();
  });

  it('"Ask about this" branches with the quote, path context and the current model', async () => {
    const s = setup();
    const done = node('a1', { seq: 1, parentId: 'u1', content: 'Light is a wave.' });
    await open(s, detail([userNode, done], [branch('trunk', { model: 'max-model' })]));
    const created = await s.store.askAbout('a1', 'a wave');

    expect(s.api.createBranch).toHaveBeenCalledWith({
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: 'a wave',
      providerId: 'openrouter',
      model: 'max-model',
    });
    expect(created?.id).toBe('side');
    expect(s.router.navigate).toHaveBeenCalledWith(['/t', 't1', 'b', 'side'], { queryParams: {} });
    expect(s.store.childBranchesAt('a1').map((b) => b.id)).toEqual(['side']);
    expect(s.ui.composerFocus()).toBe(1);

    // Following the route into the side question; back goes to the branch point.
    s.store.setRoute('t1', 'side', null);
    expect(s.store.parentBranch()?.id).toBe('trunk');
    expect(s.store.chain().map((b) => b.id)).toEqual(['trunk', 'side']);
    s.store.goToParent();
    expect(s.router.navigate).toHaveBeenLastCalledWith(['/t', 't1'], { queryParams: { m: 'a1' } });
  });

  it('"Ask your own" opens an untitled side question on the current model and asks it', async () => {
    const s = setup();
    const done = node('a1', { seq: 1, parentId: 'u1', content: 'Light is a wave.' });
    await open(s, detail([userNode, done], [branch('trunk', { model: 'max-model' })]));
    const created = await s.store.askFrom('a1', 'Why does it bend?');

    expect(s.api.createBranch).toHaveBeenCalledWith({
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: null,
      providerId: 'openrouter',
      model: 'max-model',
    });
    expect(created?.id).toBe('side');
    expect(s.router.navigate).toHaveBeenCalledWith(['/t', 't1', 'b', 'side'], { queryParams: {} });
    await vi.waitFor(() =>
      expect(s.api.sendMessage).toHaveBeenCalledWith(
        'side',
        { content: 'Why does it bend?' },
        expect.any(AbortSignal),
      ),
    );
  });

  it('a tangent is followed under its title, asked as the first message; again, it just opens', async () => {
    const s = setup();
    const done = node('a1', { seq: 1, parentId: 'u1', content: 'Light is a wave.' });
    await open(s, detail([userNode, done]));
    await s.store.followTangent('a1', 'Waves in water');
    expect(s.api.createBranch).toHaveBeenCalledWith(
      expect.objectContaining({ fromNodeId: 'a1', contextMode: 'path', title: 'Waves in water' }),
    );
    await vi.waitFor(() =>
      expect(s.api.sendMessage).toHaveBeenCalledWith(
        'side',
        { content: 'Waves in water' },
        expect.any(AbortSignal),
      ),
    );
  });

  it('"Ask your own" that cannot branch sends nothing', async () => {
    const s = setup();
    const done = node('a1', { seq: 1, parentId: 'u1', content: 'Light is a wave.' });
    await open(s, detail([userNode, done]));
    s.api.createBranch.mockRejectedValueOnce(new ApiError(500, 'internal', 'Nope'));
    await expect(s.store.askFrom('a1', 'Why?')).resolves.toBeNull();
    expect(s.api.sendMessage).not.toHaveBeenCalled();
    expect(s.ui.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Nope' });
  });

  it('the Normal/Max toggle updates the branch model', async () => {
    const s = setup();
    await open(s, detail());
    await expect(s.store.setModel('trunk', 'max-model')).resolves.toBe(true);
    expect(s.api.updateBranch).toHaveBeenCalledWith('trunk', { model: 'max-model' });
    expect(s.store.selectedBranch()?.model).toBe('max-model');
    // No request when the model is already selected.
    await s.store.setModel('trunk', 'max-model');
    expect(s.api.updateBranch).toHaveBeenCalledTimes(1);
  });

  describe('Compare', () => {
    const question = 'Why is the sky blue?';
    const committed = (): CommitCandidateResponse => ({
      userNode: node('cu', { role: 'user', content: question }),
      assistantNode: node('ca', {
        seq: 1,
        parentId: 'cu',
        content: 'Answer from max-model.',
        model: 'max-model',
      }),
      branch: branch('trunk', { title: 'Sky' }),
    });

    it('asks Normal, then Max, for the question', async () => {
      const s = setup();
      await s.store.init();
      const run = s.store.newCompare('trunk', question);
      expect(run?.candidates().map((c) => [c.id, c.label, c.model])).toEqual([
        ['normal', 'Normal', 'normal-model'],
        ['max', 'Max', 'max-model'],
      ]);
      await run!.start();
      expect(s.api.streamCandidate.mock.calls.map((c) => [c[0], c[1]])).toEqual([
        ['trunk', { content: question, model: 'normal-model' }],
        ['trunk', { content: question, model: 'max-model' }],
      ]);
      expect(run!.candidates().map((c) => c.state)).toEqual(['done', 'done']);
    });

    it('needs both tiers', async () => {
      const s = setup();
      s.api.providers.mockResolvedValue([
        { ...PROVIDER, models: [{ id: 'normal-model', label: 'Normal', tier: 'normal' }] },
      ]);
      await s.store.init();
      expect(s.store.newCompare('trunk', question)).toBeNull();
    });

    it('keeps only the picked answer, as if it had been sent', async () => {
      const s = setup();
      await s.store.init();
      await open(s, detail());
      s.store.comparing.set(true);
      expect(s.store.busy()).toBe(true);
      const run = s.store.newCompare('trunk', question)!;
      await run.start();
      s.api.commitCandidate.mockResolvedValue(committed());
      s.api.listTrees.mockClear();

      await expect(s.store.commitCompare(run, 'max')).resolves.toBe('kept');
      expect(s.api.commitCandidate).toHaveBeenCalledWith('trunk', 'cand-max-model');
      expect(s.store.path().map((n) => n.id)).toEqual(['cu', 'ca']);
      expect(s.store.selectedBranch()?.title).toBe('Sky');
      // The branch keeps its own tier; nothing is left streaming.
      expect(s.store.selectedBranch()?.model).toBe('normal-model');
      expect(s.store.live().size).toBe(0);
      expect(s.store.streamingNode()).toBeNull();
      // The composer lets the question go, and the lesson list is refreshed (auto-title).
      expect(s.ui.composerSent()).toMatchObject({ text: question });
      await vi.waitFor(() => expect(s.api.listTrees).toHaveBeenCalled());
    });

    it('an out-of-date comparison says so and keeps the question', async () => {
      const s = setup();
      await s.store.init();
      await open(s, detail());
      const run = s.store.newCompare('trunk', question)!;
      await run.start();
      s.api.commitCandidate.mockRejectedValue(
        new ApiError(410, 'gone', 'This comparison expired.'),
      );

      await expect(s.store.commitCompare(run, 'normal')).resolves.toBe('out-of-date');
      expect(s.ui.toasts().at(-1)).toMatchObject({
        kind: 'error',
        text: COMPARE_OUT_OF_DATE_MESSAGE,
      });
      expect(s.store.path()).toEqual([]);
      expect(s.ui.composerSent()).toBeNull();
      expect(s.router.navigate).not.toHaveBeenCalledWith(['/billing']);
    });

    it('a moved-on lesson (409) is out of date too', async () => {
      const s = setup();
      await s.store.init();
      await open(s, detail());
      const run = s.store.newCompare('trunk', question)!;
      await run.start();
      s.api.commitCandidate.mockRejectedValue(new ApiError(409, 'conflict', 'Moved on'));
      await expect(s.store.commitCompare(run, 'max')).resolves.toBe('out-of-date');
      expect(s.ui.toasts().at(-1)?.text).toBe(COMPARE_OUT_OF_DATE_MESSAGE);
    });

    it('a refusal is reported like a send’s (out of credit: billing)', async () => {
      const s = setup();
      await s.store.init();
      await open(s, detail());
      s.store.compareRefused(new ApiError(402, 'payment_required', 'Too low'));
      expect(s.ui.toasts().at(-1)).toMatchObject({ kind: 'error', text: OUT_OF_CREDIT_MESSAGE });
      expect(s.router.navigate).toHaveBeenCalledWith(['/billing']);

      const run = s.store.newCompare('trunk', question)!;
      await run.start();
      s.api.commitCandidate.mockRejectedValue(
        new ApiError(403, 'pool_unavailable', 'Compare isn’t available on the open pool'),
      );
      await expect(s.store.commitCompare(run, 'max')).resolves.toBe('refused');
      expect(s.ui.toasts().at(-1)?.text).toBe('Compare isn’t available on the open pool');
      expect(s.store.path()).toEqual([]);
    });

    it('a transient failure (network, 5xx) is reported and can be retried', async () => {
      const s = setup();
      await s.store.init();
      await open(s, detail());
      const run = s.store.newCompare('trunk', question)!;
      await run.start();
      s.api.commitCandidate.mockRejectedValueOnce(new ApiError(503, 'internal', 'Try again'));
      await expect(s.store.commitCompare(run, 'max')).resolves.toBe('failed');
      expect(s.ui.toasts().at(-1)?.text).toBe('Try again');
      expect(run.committing()).toBe(false);
      s.api.commitCandidate.mockResolvedValue(committed());
      await expect(s.store.commitCompare(run, 'max')).resolves.toBe('kept');
    });
  });

  describe('deleting a side question', () => {
    // trunk: u1 a1; `side` from a1 (u2 a2) with `deeper` from a2 (u3); `other` from a1 (u4).
    const lesson = () =>
      detail(
        [
          userNode,
          node('a1', { seq: 1, parentId: 'u1', content: 'Light is a wave.' }),
          node('u2', { seq: 2, parentId: 'a1', branchId: 'side', role: 'user' }),
          node('a2', { seq: 3, parentId: 'u2', branchId: 'side' }),
          node('u3', { seq: 4, parentId: 'a2', branchId: 'deeper', role: 'user' }),
          node('u4', { seq: 2, parentId: 'a1', branchId: 'other', role: 'user' }),
        ],
        [
          branch('trunk'),
          branch('side', { parentBranchId: 'trunk', branchPointNodeId: 'a1' }),
          branch('deeper', { parentBranchId: 'side', branchPointNodeId: 'a2' }),
          branch('other', { parentBranchId: 'trunk', branchPointNodeId: 'a1' }),
        ],
      );

    it('takes the side questions below with it, and leaves the open one for where it started', async () => {
      const s = setup();
      await open(s, lesson(), 'deeper');
      s.store.unsentDraft.set({ branchId: 'deeper', text: 'kept?' });
      await expect(s.store.deleteSideQuestion('side')).resolves.toBe(true);
      expect(s.api.deleteBranch).toHaveBeenCalledWith('side');
      expect(s.router.navigate).toHaveBeenLastCalledWith(['/t', 't1'], {
        queryParams: { m: 'a1' },
        replaceUrl: true,
      });
      const idx = s.store.index();
      expect([...(idx?.branches.keys() ?? [])].sort()).toEqual(['other', 'trunk']);
      expect(idx?.nodes.has('u3')).toBe(false);
      expect(s.store.childBranchesAt('a1').map((b) => b.id)).toEqual(['other']);
      expect(s.store.unsentDraft()).toBeNull();
      expect(s.ui.toasts().at(-1)?.text).toBe('Deleted the side question and 1 below it');
    });

    it('a side question open elsewhere stays open', async () => {
      const s = setup();
      await open(s, lesson(), 'other');
      s.router.navigate.mockClear();
      await s.store.deleteSideQuestion('side');
      expect(s.router.navigate).not.toHaveBeenCalled();
      expect(s.store.selectedBranchId()).toBe('other');
    });

    it('drops the connections touching its messages, and connecting from them', async () => {
      const s = setup();
      const d = lesson();
      await open(
        s,
        { ...d, links: [link('l1', 'a1', 'a2'), link('l2', 'u3', 'u4'), link('l3', 'a1', 'u4')] },
        'other',
      );
      s.ui.linkDialog.set('a2');
      s.store.linkReturn.set({
        branchId: 'side',
        nodeId: 'a2',
        toBranchId: 'other',
        toNodeId: 'u4',
      });
      await expect(s.store.deleteSideQuestion('side')).resolves.toBe(true);
      expect(s.store.links().map((l) => l.id)).toEqual(['l3']);
      expect(s.store.linksByNode().has('a2')).toBe(false);
      expect(s.ui.linkDialog()).toBeNull();
      expect(s.store.linkReturn()).toBeNull();
    });

    it('never deletes the lesson itself; a refusal changes nothing', async () => {
      const s = setup();
      await open(s, lesson(), 'side');
      await expect(s.store.deleteSideQuestion('trunk')).resolves.toBe(false);
      expect(s.api.deleteBranch).not.toHaveBeenCalled();
      s.api.deleteBranch.mockRejectedValueOnce(new ApiError(409, 'conflict', 'Still writing'));
      s.router.navigate.mockClear();
      await expect(s.store.deleteSideQuestion('side')).resolves.toBe(false);
      expect(s.router.navigate).not.toHaveBeenCalled();
      expect(s.store.index()?.branches.size).toBe(4);
      expect(s.ui.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Still writing' });
    });
  });

  it('deleting the open lesson returns home', async () => {
    const s = setup();
    s.api.listTrees.mockResolvedValue([
      {
        id: 't1',
        title: 'Photosynthesis',
        createdAt: T,
        updatedAt: T,
        branchCount: 1,
        messageCount: 0,
      },
    ]);
    await s.store.init();
    await open(s, detail());
    await expect(s.store.deleteLesson('t1')).resolves.toBe(true);
    expect(s.api.deleteTree).toHaveBeenCalledWith('t1');
    expect(s.store.trees()).toEqual([]);
    expect(s.router.navigate).toHaveBeenCalledWith(['/']);
  });
  it('Export downloads the lesson as the same JSON backup as power mode, named after it', async () => {
    const s = setup();
    const d = detail([
      userNode,
      node('a1', { seq: 1, parentId: 'u1', content: 'Light is a wave.' }),
    ]);
    s.api.backup.mockResolvedValue(backupOf(d));
    const pending = s.store.exportLesson('t1');
    expect(s.store.exportingId()).toBe('t1');
    // One export at a time.
    await expect(s.store.exportLesson('t2')).resolves.toBe(false);
    await expect(pending).resolves.toBe(true);
    expect(s.store.exportingId()).toBeNull();
    expect(s.api.backup).toHaveBeenCalledTimes(1);
    expect(s.api.backup).toHaveBeenCalledWith('t1');
    const [name, blob] = s.saveFile.mock.calls[0]!;
    expect(name).toBe('photosynthesis.tangent.json');
    expect(JSON.parse(await blob.text())).toEqual(backupOf(d));
  });

  it('a failed Export is a toast and saves nothing', async () => {
    const s = setup();
    s.api.backup.mockRejectedValue(new ApiError(404, 'not_found', 'Tree not found'));
    await expect(s.store.exportLesson('t1')).resolves.toBe(false);
    expect(s.saveFile).not.toHaveBeenCalled();
    expect(s.ui.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Tree not found' });
    expect(s.store.exportingId()).toBeNull();
  });

  it('Import sends the backup, lists the new lesson first and opens it', async () => {
    const s = setup();
    const imported = { ...detail(), tree: { ...detail().tree, id: 't9', title: 'Imported' } };
    s.api.importBackup.mockResolvedValue(imported);
    const file = new File([JSON.stringify(backupOf(detail()))], 'photosynthesis.tangent.json');
    await expect(s.store.importLesson(file)).resolves.toBe(true);
    expect(s.api.importBackup).toHaveBeenCalledWith(backupOf(detail()));
    expect(s.store.trees().map((t) => t.id)).toEqual(['t9']);
    expect(s.ui.toasts().at(-1)).toMatchObject({ kind: 'info', text: 'Imported “Imported”' });
    expect(s.router.navigate).toHaveBeenCalledWith(['/t', 't9']);
    expect(s.store.importing()).toBe(false);
  });

  it('Import refuses a file that is not a usable backup before sending anything', async () => {
    const s = setup();
    for (const [file, text] of [
      [new File(['# Notes'], 'notes.md'), /^notes\.md is not a JSON file\./],
      [new File(['{"title":"x"}'], 'other.json'), /^other\.json is not a Tangent backup\.$/],
      [new File([''], 'empty.json'), /^empty\.json is empty\.$/],
    ] as const) {
      await expect(s.store.importLesson(file)).resolves.toBe(false);
      expect(s.ui.toasts().at(-1)).toMatchObject({
        kind: 'error',
        text: expect.stringMatching(text),
      });
    }
    expect(s.api.importBackup).not.toHaveBeenCalled();
    expect(s.router.navigate).not.toHaveBeenCalled();
    expect(s.store.importing()).toBe(false);
  });

  it("the server's refusal of an import is a toast", async () => {
    const s = setup();
    s.api.importBackup.mockRejectedValue(
      new ApiError(400, 'bad_request', 'Backup must contain exactly one trunk branch'),
    );
    const file = new File([JSON.stringify(backupOf(detail()))], 'lesson.json');
    await expect(s.store.importLesson(file)).resolves.toBe(false);
    expect(s.ui.toasts().at(-1)).toMatchObject({
      kind: 'error',
      text: 'Backup must contain exactly one trunk branch',
    });
    expect(s.store.trees()).toEqual([]);
  });

  describe('Check sources', () => {
    const done = node('a1', { seq: 1, parentId: 'u1', content: 'Light is a wave.' });
    const later = [
      node('u2', { seq: 2, parentId: 'a1', role: 'user' }),
      node('a2', { seq: 3, parentId: 'u2' }),
    ];

    it('is offered only on providers that can search', async () => {
      const s = setup();
      await open(s, detail([userNode, done]));
      expect(s.store.canCheckSources('trunk')).toBe(false);
      s.store.providers.set([{ ...PROVIDER, webSearch: true }]);
      expect(s.store.canCheckSources('trunk')).toBe(true);
      expect(s.store.depthOf('trunk')).toBe(0);
    });

    it('appends a required check after the branch\u2019s last reply, quoting the question', async () => {
      const s = setup();
      await open(s, detail([userNode, done]));
      await s.store.checkSources('a1');
      expect(s.api.createBranch).not.toHaveBeenCalled();
      expect(s.api.sendMessage).toHaveBeenCalledWith(
        'trunk',
        { content: 'Check your last answer against sources: "What is light?"', ground: 'required' },
        expect.any(AbortSignal),
      );
    });

    it('checks an earlier reply in a side question', async () => {
      const s = setup();
      await open(s, detail([userNode, done, ...later]));
      await s.store.checkSources('a1');
      expect(s.api.createBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          fromNodeId: 'a1',
          title: 'Checking sources',
          contextMode: 'path',
        }),
      );
      expect(s.api.sendMessage).toHaveBeenCalledWith(
        'side',
        expect.objectContaining({ ground: 'required' }),
        expect.any(AbortSignal),
      );
    });

    it('on the last reply of the branch a side question started from, opens a side question', async () => {
      const s = setup();
      const asked = branch('asked', { parentBranchId: 'trunk', branchPointNodeId: 'a1' });
      const own = [
        node('u2', { seq: 2, parentId: 'a1', branchId: 'asked', role: 'user' }),
        node('a2', { seq: 3, parentId: 'u2', branchId: 'asked' }),
      ];
      await open(s, detail([userNode, done, ...own], [branch('trunk'), asked]), 'asked');
      await s.store.checkSources('a1');
      expect(s.api.createBranch).toHaveBeenCalledWith(
        expect.objectContaining({ fromNodeId: 'a1', title: 'Checking sources' }),
      );
      expect(s.api.sendMessage).toHaveBeenCalledTimes(1);
      expect(s.api.sendMessage).toHaveBeenCalledWith(
        'side',
        expect.objectContaining({ ground: 'required' }),
        expect.any(AbortSignal),
      );
    });
  });

  describe('Connections', () => {
    const trunkNodes = [
      userNode,
      node('a1', { seq: 1, parentId: 'u1', content: 'Light is a wave.' }),
      node('u2', { seq: 2, parentId: 'a1', role: 'user' }),
      node('a2', { seq: 3, parentId: 'u2', content: 'And a particle.' }),
    ];
    const side = branch('side', { parentBranchId: 'trunk', branchPointNodeId: 'a1' });
    const sideNodes = [
      node('s1', { branchId: 'side', parentId: 'a1', role: 'user', content: 'Why a wave?' }),
      node('s2', { branchId: 'side', seq: 1, parentId: 's1', content: 'It interferes.' }),
    ];
    const lesson = (links: NodeLink[] = []) =>
      detail([...trunkNodes, ...sideNodes], [branch('trunk'), side], links);

    it('connects two messages: listed under both ends, with a toast', async () => {
      const s = setup();
      await open(s, lesson());
      const created = await s.store.createLink('a1', 's2', 'Same idea');

      expect(s.api.createLink).toHaveBeenCalledWith({
        fromNodeId: 'a1',
        toNodeId: 's2',
        note: 'Same idea',
      });
      expect(created?.id).toBe('l-new');
      expect(s.store.links().map((l) => l.id)).toEqual(['l-new']);
      expect(
        s.store
          .linksByNode()
          .get('a1')
          ?.map((l) => l.id),
      ).toEqual(['l-new']);
      expect(
        s.store
          .linksByNode()
          .get('s2')
          ?.map((l) => l.id),
      ).toEqual(['l-new']);
      expect(s.ui.toasts().at(-1)).toMatchObject({ kind: 'info', text: 'Connected' });
    });

    it('an already connected pair answers with the existing connection, not a second one', async () => {
      const s = setup();
      await open(s, lesson([link('l1', 's2', 'a1')]));
      s.api.createLink.mockResolvedValue({ link: link('l1', 's2', 'a1'), created: false });
      await s.store.createLink('a1', 's2', null);
      expect(s.store.links().map((l) => l.id)).toEqual(['l1']);
      expect(s.ui.toasts().at(-1)).toMatchObject({ text: 'Already connected' });
    });

    it('a refused connection is a toast and changes nothing', async () => {
      const s = setup();
      await open(s, lesson());
      s.api.createLink.mockRejectedValue(new ApiError(404, 'not_found', 'Node not found'));
      await expect(s.store.createLink('a1', 'gone', null)).resolves.toBeNull();
      expect(s.store.links()).toEqual([]);
      expect(s.ui.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Node not found' });
    });

    it('a connection of another lesson (opened meanwhile) is not applied', async () => {
      const s = setup();
      await open(s, lesson());
      s.api.createLink.mockResolvedValue({
        link: { ...link('l-new', 'a1', 's2'), treeId: 't2' },
        created: true,
      });
      await s.store.createLink('a1', 's2', null);
      expect(s.store.links()).toEqual([]);
    });

    it('edits and clears a note', async () => {
      const s = setup();
      await open(s, lesson([link('l1', 'a1', 'a2', 'Old')]));
      await expect(s.store.updateLink('l1', 'New')).resolves.toBe(true);
      expect(s.api.updateLink).toHaveBeenCalledWith('l1', { note: 'New' });
      expect(s.store.links()[0]?.note).toBe('New');
      await s.store.updateLink('l1', null);
      expect(s.store.links()[0]?.note).toBeNull();
    });

    it('removes a connection from both ends', async () => {
      const s = setup();
      await open(s, lesson([link('l1', 'a1', 's2'), link('l2', 'a2', 's1')]));
      await expect(s.store.deleteLink('l1')).resolves.toBe(true);
      expect(s.api.deleteLink).toHaveBeenCalledWith('l1');
      expect(s.store.links().map((l) => l.id)).toEqual(['l2']);
      expect(s.store.linksByNode().has('a1')).toBe(false);
      expect(s.store.linksByNode().has('s2')).toBe(false);
      expect(s.ui.toasts().at(-1)).toMatchObject({ text: 'Connection removed' });
    });

    it('a failed removal keeps the connection', async () => {
      const s = setup();
      await open(s, lesson([link('l1', 'a1', 's2')]));
      s.api.deleteLink.mockRejectedValue(new ApiError(0, 'network', 'Network error'));
      await expect(s.store.deleteLink('l1')).resolves.toBe(false);
      expect(s.store.links().map((l) => l.id)).toEqual(['l1']);
      expect(s.ui.toasts().at(-1)).toMatchObject({ kind: 'error' });
    });

    it('a connection already removed elsewhere (404) goes from both ends here too', async () => {
      const s = setup();
      await open(s, lesson([link('l1', 'a1', 's2'), link('l2', 'a2', 's1')]));
      s.api.deleteLink.mockRejectedValue(new ApiError(404, 'not_found', 'Link not found'));
      await expect(s.store.deleteLink('l1')).resolves.toBe(true);
      expect(s.store.links().map((l) => l.id)).toEqual(['l2']);
      expect(s.ui.toasts().at(-1)).toMatchObject({
        kind: 'info',
        text: 'That connection was already removed',
      });

      s.api.updateLink.mockRejectedValue(new ApiError(404, 'not_found', 'Link not found'));
      await expect(s.store.updateLink('l2', 'Why')).resolves.toBe(false);
      expect(s.store.links()).toEqual([]);
    });

    it('following a connection opens the other end and offers the way back', async () => {
      const s = setup();
      await open(s, lesson([link('l1', 'a1', 's2')]));
      s.store.openNode('s2', 'a1');
      expect(s.router.navigate).toHaveBeenLastCalledWith(['/t', 't1', 'b', 'side'], {
        queryParams: { m: 's2' },
      });
      expect(s.store.linkReturn()).toEqual({
        branchId: 'trunk',
        nodeId: 'a1',
        toBranchId: 'side',
        toNodeId: 's2',
      });

      // The route follows; the way back stays offered there.
      s.store.setRoute('t1', 'side', 's2');
      expect(s.store.linkReturn()).not.toBeNull();

      s.store.goBackFromLink();
      expect(s.router.navigate).toHaveBeenLastCalledWith(['/t', 't1'], {
        queryParams: { m: 'a1' },
      });
      expect(s.store.linkReturn()).toBeNull();
    });

    it("the browser's Back to where the connection was followed from drops the pill", async () => {
      const s = setup();
      await open(s, lesson([link('l1', 'a1', 's2')]));
      s.store.openNode('s2', 'a1');
      s.store.setRoute('t1', 'side', 's2');
      // Learn messages don't put `?m=` in the URL, so Back lands on the bare lesson.
      s.store.setRoute('t1', null, null);
      expect(s.store.linkReturn()).toBeNull();
    });

    it('the way back stays offered on the branch the connection went to, and only there', async () => {
      const s = setup();
      await open(s, lesson([link('l1', 'a1', 's2')]));
      s.store.openNode('s2', 'a1');
      s.store.setRoute('t1', 'side', 's2');
      // Sending there drops `?m=` (a replaced URL): still on the connection's branch.
      s.store.setRoute('t1', 'side', null);
      expect(s.store.linkReturn()).not.toBeNull();
      s.store.setRoute('t1', null, 'a2');
      expect(s.store.linkReturn()).toBeNull();
    });

    it('opening another lesson forgets the way back', async () => {
      const s = setup();
      await open(s, lesson([link('l1', 'a1', 's2')]));
      s.store.openNode('s2', 'a1');
      s.store.setRoute('t2', null, null);
      expect(s.store.linkReturn()).toBeNull();
    });

    it('a connection to a message that is gone goes nowhere', async () => {
      const s = setup();
      await open(s, lesson());
      s.router.navigate.mockClear();
      s.store.openNode('gone', 'a1');
      expect(s.router.navigate).not.toHaveBeenCalled();
      expect(s.store.linkReturn()).toBeNull();
    });
  });
});

describe('LessonStore a lesson load that lands late', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  function slowLoad() {
    const s = setup();
    let land!: (d: TreeDetail) => void;
    s.api.getTree.mockReturnValue(new Promise<TreeDetail>((r) => (land = r)));
    s.api.createTree.mockResolvedValue({ ...detail(), tree: { ...detail().tree, id: 't2' } });
    s.store.setRoute('t1', null, null);
    return { ...s, land: (d: TreeDetail) => land(d) };
  }

  it('going home while it loads: home stays empty', async () => {
    const s = slowLoad();
    s.store.setRoute(null, null, null);
    s.land(detail());
    await new Promise((r) => setTimeout(r, 0));
    expect(s.store.detail()).toBeNull();
    expect(s.store.detailLoading()).toBe(false);
  });

  it('starting a new lesson while it loads: the new one stays open', async () => {
    const s = slowLoad();
    await s.store.startLesson(null, '');
    s.land(detail());
    await new Promise((r) => setTimeout(r, 0));
    expect(s.store.detail()?.tree.id).toBe('t2');
    expect(s.store.detailLoading()).toBe(false);
  });
});
