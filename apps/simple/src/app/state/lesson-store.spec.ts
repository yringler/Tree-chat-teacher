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
  MeResponse,
  NodeLink,
  ProviderInfo,
  StreamEvent,
  TreeBackup,
  TreeBackupInput,
  TreeDetail,
  TreeSummary,
} from '@tangent/shared';
import {
  ApiClient,
  ApiError,
  ComposerController,
  SAVE_FILE,
  ToastStore,
  type PoolBlock,
} from '@tangent/web-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStore } from './account-store';
import { COMPARE_OUT_OF_DATE_MESSAGE, LessonStore, OUT_OF_CREDIT_MESSAGE } from './lesson-store';
import { LearnFunding } from './learn-funding';
import { PaymentChoice } from './payment-choice';
import { UiStore } from './ui-store';

const T = '2026-01-01T00:00:00.000Z';

/** The composer controller, its calls recorded. */
function spyComposer(c: ComposerController): ComposerController {
  vi.spyOn(c, 'sent');
  vi.spyOn(c, 'focus');
  return c;
}

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
};

function setup() {
  const api = fakeApi();
  const router = { navigate: vi.fn(async (_commands: unknown[], _extras?: unknown) => true) };
  const saveFile = vi.fn((_name: string, _blob: Blob) => undefined);
  const injector = Injector.create({
    providers: [
      { provide: LessonStore },
      { provide: UiStore },
      { provide: ComposerController },
      { provide: ToastStore },
      { provide: AccountStore },
      { provide: PaymentChoice },
      { provide: LearnFunding },
      { provide: ApiClient, useValue: api },
      { provide: Router, useValue: router },
      { provide: SAVE_FILE, useValue: saveFile },
    ],
  });
  const store = injector.get(LessonStore);
  const ui = injector.get(UiStore);
  const composer = spyComposer(injector.get(ComposerController));
  const toasts = injector.get(ToastStore);
  return { store, ui, composer, toasts, api, router, injector, saveFile };
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
      {
        type: 'start',
        userNode,
        assistantNode: replyNode,
        branch: branch('trunk'),
        funding: 'credit',
      },
      { type: 'status', message: 'Thinking…' },
    ]);
    s.api.sendMessage.mockResolvedValue(live.response);
    const sending = s.store.send('trunk', 'What is light?');
    expect(s.store.busy()).toBe(true);
    // The composer keeps the text until the message is in the lesson.
    expect(s.composer.sent).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(s.store.live().get('a1')?.status).toBe('Thinking…'));
    expect(s.composer.sent).toHaveBeenCalledWith('trunk', 'What is light?');
    expect(s.store.streamingNode()?.id).toBe('a1');
    expect(s.store.sending().size).toBe(0);

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

  it('402 on send: offers billing with a toast and keeps the message', async () => {
    const s = setup();
    await open(s, detail());
    s.api.sendMessage.mockRejectedValue(
      new ApiError(402, 'payment_required', 'Your balance is too low'),
    );
    await expect(s.store.send('trunk', 'What is light?')).resolves.toBe(false);

    expect(s.router.navigate).toHaveBeenCalledWith(['/billing']);
    expect(s.toasts.toasts().at(-1)).toMatchObject({ kind: 'error', text: OUT_OF_CREDIT_MESSAGE });
    expect(s.store.unsentDraft()).toEqual({
      treeId: 't1',
      branchId: 'trunk',
      text: 'What is light?',
    });
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

    expect(s.ui.dialogs.isOpen('access')).toBe(true);
    expect(s.toasts.toasts().at(-1)).toMatchObject({ kind: 'error' });
    expect(s.router.navigate).not.toHaveBeenCalledWith(['/billing']);
    expect(s.store.unsentDraft()).toEqual({
      treeId: 't1',
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
      expect(s.store.unsentDraft()).toEqual({
        treeId: 't1',
        branchId: 'trunk',
        text: 'What is light?',
      }),
    );
    expect(s.store.resumeUnsent()).toBe(false);
  });

  it('switching who pays, from wherever, sends the message the key held back and clears the pool notice', async () => {
    const s = setup();
    await open(s, detail());
    s.api.sendMessage.mockRejectedValueOnce(new ApiError(401, 'key_required', 'Add your key'));
    await s.store.send('trunk', 'What is light?');
    expect(s.store.unsentDraft()).toMatchObject({ needsKey: true });
    s.store.poolBlock.set({
      kind: 'empty',
      details: { reason: 'empty', limit: null, resetAt: null },
      branchId: 'trunk',
    });
    const funding = s.injector.get(LearnFunding);

    // The own key needs a key first: nothing is sent yet.
    expect(funding.switchTo('own-key')).toBe(false);
    expect(s.store.poolBlock()).toBeNull();
    expect(s.api.sendMessage).toHaveBeenCalledTimes(1);

    expect(funding.switchTo('pool')).toBe(true);
    await vi.waitFor(() => expect(s.api.sendMessage).toHaveBeenCalledTimes(2));
  });

  it('402 membership_required on send: locks the own key, no toast, keeps the message', async () => {
    const s = setup();
    const funding = s.injector.get(LearnFunding);
    funding.setMembership({ ...BILLING.membership, required: true, status: 'active' });
    s.api.billing.mockResolvedValue({
      ...BILLING,
      membership: { ...BILLING.membership, required: true, status: 'inactive' },
    });
    await open(s, detail());
    s.api.sendMessage.mockRejectedValue(
      new ApiError(402, 'membership_required', 'A membership is required'),
    );
    await expect(s.store.send('trunk', 'What is light?')).resolves.toBe(false);

    expect(funding.membershipBlocked()).toBe(true);
    expect(s.router.navigate).not.toHaveBeenCalledWith(['/billing']);
    expect(s.toasts.toasts()).toEqual([]);
    expect(s.store.unsentDraft()).toEqual({
      treeId: 't1',
      branchId: 'trunk',
      text: 'What is light?',
    });
    await vi.waitFor(() => expect(funding.billing()?.membership.status).toBe('inactive'));
    expect(funding.membershipBlocked()).toBe(true);
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
    expect(s.toasts.toasts()).toEqual([]);
    expect(s.router.navigate).not.toHaveBeenCalled();
    expect(s.store.unsentDraft()).toEqual({
      treeId: 't1',
      branchId: 'trunk',
      text: 'What is light?',
    });
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
    expect(s.toasts.toasts()).toEqual([]);
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
    expect(s.ui.dialogs.isOpen('pool-verify')).toBe(true);
    expect(s.toasts.toasts()).toEqual([]);
    expect(s.store.poolBlock()).toBeNull();
    expect(s.store.unsentDraft()?.text).toBe('What is light?');
  });

  it('other pool_unavailable reasons are reported as a toast', async () => {
    const s = setup();
    await open(s, detail());
    s.api.sendMessage.mockRejectedValue(
      new ApiError(403, 'pool_unavailable', 'Open pool access is suspended for this account'),
    );
    await s.store.send('trunk', 'What is light?');
    expect(s.ui.dialogs.isOpen('pool-verify')).toBe(false);
    expect(s.toasts.toasts().at(-1)).toMatchObject({
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
    expect(s.toasts.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Still generating' });
    // Nothing was written: the message is offered back, not lost.
    expect(s.store.unsentDraft()).toEqual({ treeId: 't1', branchId: 'trunk', text: 'Hi' });
    expect(s.composer.sent).not.toHaveBeenCalled();
  });

  it('"Ask about this" branches with the quote, path context and the current model', async () => {
    const s = setup();
    const done = node('a1', { seq: 1, parentId: 'u1', content: 'Light is a wave.' });
    await open(s, detail([userNode, done], [branch('trunk', { model: 'max-model' })]));
    const created = await s.store.createBranch({
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: 'a wave',
    });

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
    expect(s.composer.focus).toHaveBeenCalledTimes(1);

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
    expect(s.toasts.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Nope' });
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
      expect(s.composer.sent).toHaveBeenCalledWith(expect.any(String), question);
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
      expect(s.toasts.toasts().at(-1)).toMatchObject({
        kind: 'error',
        text: COMPARE_OUT_OF_DATE_MESSAGE,
      });
      expect(s.store.path()).toEqual([]);
      expect(s.composer.sent).not.toHaveBeenCalled();
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
      expect(s.toasts.toasts().at(-1)?.text).toBe(COMPARE_OUT_OF_DATE_MESSAGE);
    });

    it('a refusal is reported like a send’s (out of credit: billing)', async () => {
      const s = setup();
      await s.store.init();
      await open(s, detail());
      s.store.compareRefused(new ApiError(402, 'payment_required', 'Too low'));
      expect(s.toasts.toasts().at(-1)).toMatchObject({
        kind: 'error',
        text: OUT_OF_CREDIT_MESSAGE,
      });
      expect(s.router.navigate).toHaveBeenCalledWith(['/billing']);

      const run = s.store.newCompare('trunk', question)!;
      await run.start();
      s.api.commitCandidate.mockRejectedValue(
        new ApiError(403, 'pool_unavailable', 'Compare isn’t available on the open pool'),
      );
      await expect(s.store.commitCompare(run, 'max')).resolves.toBe('refused');
      expect(s.toasts.toasts().at(-1)?.text).toBe('Compare isn’t available on the open pool');
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
      expect(s.toasts.toasts().at(-1)?.text).toBe('Try again');
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

    it('drops the connections touching its messages, and connecting from them', async () => {
      const s = setup();
      const d = lesson();
      await open(
        s,
        { ...d, links: [link('l1', 'a1', 'a2'), link('l2', 'u3', 'u4'), link('l3', 'a1', 'u4')] },
        'other',
      );
      s.ui.dialogs.open({ kind: 'connect', sourceNodeId: 'a2' });
      s.store.linkReturn.set({
        branchId: 'side',
        nodeId: 'a2',
        toBranchId: 'other',
        toNodeId: 'u4',
      });
      await expect(s.store.deleteSideQuestion('side')).resolves.toBe(true);
      expect(s.store.links().map((l) => l.id)).toEqual(['l3']);
      expect(s.store.linksByNode().has('a2')).toBe(false);
      expect(s.ui.dialogs.get('connect')).toBeNull();
      expect(s.store.linkReturn()).toBeNull();
      // In Learn's words.
      expect(s.toasts.toasts().at(-1)?.text).toBe('Deleted the side question and 1 below it');
    });

    it('drops the message left unsent there, and the pool notice, but not those elsewhere', async () => {
      const s = setup();
      await open(s, lesson(), 'other');
      const block: PoolBlock = {
        kind: 'empty',
        details: { reason: 'empty', limit: null, resetAt: null },
      };
      s.store.unsentDraft.set({ treeId: 't1', branchId: 'side', text: 'Why?' });
      s.store.poolBlock.set({ ...block, branchId: 'deeper' });
      await expect(s.store.deleteSideQuestion('side')).resolves.toBe(true);
      expect(s.store.unsentDraft()).toBeNull();
      expect(s.store.poolBlock()).toBeNull();

      const t = setup();
      await open(t, lesson(), 'other');
      t.store.unsentDraft.set({ treeId: 't1', branchId: 'other', text: 'Why?' });
      t.store.poolBlock.set({ ...block, branchId: 'other' });
      await expect(t.store.deleteSideQuestion('side')).resolves.toBe(true);
      expect(t.store.unsentDraft()?.branchId).toBe('other');
      expect(t.store.poolBlock()?.branchId).toBe('other');
    });

    it('says a connection is removed, or was already, in Learn’s words', async () => {
      const s = setup();
      await open(s, { ...lesson(), links: [link('l1', 'a1', 'a2'), link('l2', 'u3', 'u4')] });
      await expect(s.store.deleteLink('l1')).resolves.toBe(true);
      expect(s.toasts.toasts().at(-1)?.text).toBe('Connection removed');
      s.api.deleteLink.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Gone'));
      await s.store.deleteLink('l2');
      expect(s.toasts.toasts().at(-1)?.text).toBe('That connection was already removed');
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
      expect(s.toasts.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Still writing' });
    });
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
    expect(s.toasts.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Tree not found' });
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
    expect(s.toasts.toasts().at(-1)).toMatchObject({ kind: 'info', text: 'Imported “Imported”' });
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
      expect(s.toasts.toasts().at(-1)).toMatchObject({
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
    expect(s.toasts.toasts().at(-1)).toMatchObject({
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
      expect(s.toasts.toasts().at(-1)).toMatchObject({ kind: 'info', text: 'Connected' });
    });

    it('edits and clears a note', async () => {
      const s = setup();
      await open(s, lesson([link('l1', 'a1', 'a2', 'Old')]));
      await expect(s.store.updateLinkNote('l1', 'New')).resolves.toBe(true);
      expect(s.api.updateLink).toHaveBeenCalledWith('l1', { note: 'New' });
      expect(s.store.links()[0]?.note).toBe('New');
      await s.store.updateLinkNote('l1', null);
      expect(s.store.links()[0]?.note).toBeNull();
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

describe('LessonStore a refused message across leaving the page', () => {
  /** This tab's sessionStorage, across the "page loads" of a test. */
  let tab: Map<string, string>;

  beforeEach(() => {
    tab = new Map();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => tab.get(k) ?? null,
      setItem: (k: string, v: string) => void tab.set(k, v),
      removeItem: (k: string) => void tab.delete(k),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const reply = node('a1', { seq: 1, parentId: 'u1', content: 'Light is a wave.' });
  const lesson = () => detail([userNode, reply]);

  /** A new page (a new store) signed in as `userId`, booted as the app boots it. */
  async function page(userId: string) {
    const s = setup();
    s.injector.get(AccountStore).me.set({
      userId,
      builtInCredit: true,
      membership: { ...BILLING.membership, required: false },
    } as MeResponse);
    await s.store.init();
    return s;
  }

  it('a message refused for want of credit is back in its lesson after the checkout', async () => {
    const before = await page('u1');
    await open(before, lesson());
    before.api.sendMessage.mockRejectedValue(
      new ApiError(402, 'payment_required', 'Your balance is too low'),
    );
    await before.store.send('trunk', 'Why does it bend?');
    expect(before.router.navigate).toHaveBeenCalledWith(['/billing']);

    // Checkout is a full-page redirect: a new page, a new store.
    const after = await page('u1');
    expect(after.store.unsentDraft()).toEqual({
      treeId: 't1',
      branchId: 'trunk',
      text: 'Why does it bend?',
    });
    await open(after, lesson());
    after.api.sendMessage.mockResolvedValue(stream([]));
    await after.store.send('trunk', 'Why does it bend?');
    expect(after.store.unsentDraft()).toBeNull();
    expect((await page('u1')).store.unsentDraft()).toBeNull();
  });

  it('is never offered to someone else signed in on the tab, and goes with sign-out', async () => {
    const first = await page('u1');
    await open(first, lesson());
    first.api.sendMessage.mockRejectedValue(new ApiError(500, 'internal', 'boom'));
    await first.store.send('trunk', 'Private question');
    expect(tab.size).toBe(1);

    const other = await page('u2');
    expect(other.store.unsentDraft()).toBeNull();
    expect(tab.size).toBe(0);

    const again = await page('u1');
    await open(again, lesson());
    again.api.sendMessage.mockRejectedValue(new ApiError(500, 'internal', 'boom'));
    await again.store.send('trunk', 'Private question');
    expect(tab.size).toBe(1);
    again.store.forgetUnsent();
    expect(again.store.unsentDraft()).toBeNull();
    expect(tab.size).toBe(0);
  });

  it('a "Check sources" request the pool refuses is not kept as the learner’s message', async () => {
    const s = setup();
    await open(s, lesson());
    s.store.unsentDraft.set({ treeId: 't1', branchId: 'trunk', text: 'Typed by the learner' });
    s.api.sendMessage.mockRejectedValue(
      new ApiError(402, 'pool_empty', 'The open pool is empty', {
        reason: 'empty',
        limit: null,
        resetAt: null,
      }),
    );
    await s.store.checkSources('a1');
    expect(s.store.poolBlock()?.branchId).toBe('trunk');
    expect(s.store.unsentDraft()).toEqual({
      treeId: 't1',
      branchId: 'trunk',
      text: 'Typed by the learner',
    });
  });

  it('a "Check sources" refused for want of the key is resent as one once the key is settled', async () => {
    const s = setup();
    await open(s, lesson());
    s.api.sendMessage.mockRejectedValueOnce(new ApiError(401, 'key_required', 'Add your key'));
    await s.store.checkSources('a1');
    expect(s.store.unsentDraft()).toMatchObject({ ground: 'required', needsKey: true });
    s.api.sendMessage.mockResolvedValue(stream([]));
    expect(s.store.resumeUnsent()).toBe(true);
    await vi.waitFor(() => expect(s.api.sendMessage).toHaveBeenCalledTimes(2));
    expect(s.api.sendMessage.mock.calls[1]![1]).toMatchObject({ ground: 'required' });
  });

  it('a refused "Check sources" never takes the place of the learner’s own message', async () => {
    const s = setup();
    await open(s, lesson());
    s.api.sendMessage.mockRejectedValue(new ApiError(401, 'key_required', 'Add your key'));
    await s.store.send('trunk', 'Why does it bend?');
    await s.store.checkSources('a1');
    expect(s.store.unsentDraft()).toEqual({
      treeId: 't1',
      branchId: 'trunk',
      text: 'Why does it bend?',
      needsKey: true,
    });
    s.api.sendMessage.mockResolvedValue(stream([]));
    expect(s.store.resumeUnsent()).toBe(true);
    await vi.waitFor(() => expect(s.api.sendMessage).toHaveBeenCalledTimes(3));
    expect(s.api.sendMessage.mock.calls[2]!.slice(0, 2)).toEqual([
      'trunk',
      { content: 'Why does it bend?' },
    ]);
  });

  it('the composer takes back only text the learner typed, in its own branch', async () => {
    const s = setup();
    await open(s, lesson());
    s.store.unsentDraft.set({ treeId: 't1', branchId: 'trunk', text: 'Typed' });
    expect(s.store.composerDraft()).toBe('Typed');
    s.store.unsentDraft.set({ treeId: 't1', branchId: 'side', text: 'Elsewhere' });
    expect(s.store.composerDraft()).toBe('');
    s.store.unsentDraft.set({
      treeId: 't1',
      branchId: 'trunk',
      text: 'Check your last answer against sources',
      ground: 'required',
    });
    expect(s.store.composerDraft()).toBe('');
  });

  it('resending an unsent message keeps its options', async () => {
    const s = setup();
    await open(s, lesson());
    s.store.unsentDraft.set({
      treeId: 't1',
      branchId: 'trunk',
      text: 'Check it',
      ground: 'required',
      needsKey: true,
    });
    s.api.sendMessage.mockResolvedValue(stream([]));
    expect(s.store.resumeUnsent()).toBe(true);
    await vi.waitFor(() => expect(s.api.sendMessage).toHaveBeenCalledTimes(1));
    expect(s.api.sendMessage.mock.calls[0]!.slice(0, 2)).toEqual([
      'trunk',
      { content: 'Check it', ground: 'required' },
    ]);
  });

  it('a message of another lesson waits for its lesson', async () => {
    const s = setup();
    await open(s, lesson());
    s.store.unsentDraft.set({ treeId: 't9', branchId: 'x', text: 'Elsewhere', needsKey: true });
    expect(s.store.resumeUnsent()).toBe(false);
    expect(s.api.sendMessage).not.toHaveBeenCalled();
  });
});

describe('LessonStore refreshing after replies', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A whole exchange on the trunk, streamed at once. */
  function exchange(i: number): Response {
    const ask = node(`u-${i}`, { seq: 10 + 2 * i, role: 'user', content: 'Why?' });
    const reply = node(`r-${i}`, { seq: 11 + 2 * i, parentId: `u-${i}`, content: 'Because.' });
    return stream([
      {
        type: 'start',
        userNode: ask,
        assistantNode: { ...reply, status: 'streaming' },
        branch: branch('trunk'),
        funding: 'credit',
      },
      { type: 'done', node: reply, branch: branch('trunk') },
    ]);
  }

  const summaryOf = (title: string): TreeSummary => ({
    id: 't1',
    title,
    createdAt: T,
    updatedAt: T,
    branchCount: 1,
    messageCount: 2,
  });

  it('replies finishing together share one refresh of the lessons and the balance, plus one more', async () => {
    const s = setup();
    await open(s, detail());
    let i = 0;
    s.api.sendMessage.mockImplementation(async () => exchange(i++));
    const reads: ((list: TreeSummary[]) => void)[] = [];
    s.api.listTrees.mockImplementation(() => new Promise<TreeSummary[]>((r) => reads.push(r)));
    s.api.billing.mockClear();
    await Promise.all(Array.from({ length: 6 }, () => s.store.send('trunk', 'Why?')));
    expect(reads).toHaveLength(1);
    expect(s.api.billing).toHaveBeenCalledTimes(1);
    reads[0]!([summaryOf('Light')]);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]!([summaryOf('Light and waves')]);
    await vi.waitFor(() => expect(s.store.detail()?.tree.title).toBe('Light and waves'));
    expect(reads).toHaveLength(2);
    expect(s.api.billing).toHaveBeenCalledTimes(2);
  });
});
