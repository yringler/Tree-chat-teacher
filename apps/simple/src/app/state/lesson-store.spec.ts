import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import { Router } from '@angular/router';
import type {
  BillingSummary,
  Branch,
  PoolBlockDetails,
  PoolStatusResponse,
  ChatNode,
  CreateBranchRequest,
  ProviderInfo,
  StreamEvent,
  TreeDetail,
  TreeSummary,
} from '@tangent/shared';
import { POOL_NOTICE_VERSION } from '@tangent/shared';
import { ApiClient, ApiError } from '@tangent/web-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStore } from './account-store';
import { LessonStore, OUT_OF_CREDIT_MESSAGE } from './lesson-store';
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
    providerId: 'tangent',
    model: 'smart-model',
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

function detail(nodes: ChatNode[] = [], branches: Branch[] = [branch('trunk')]): TreeDetail {
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
  id: 'tangent',
  kind: 'openai-compatible',
  label: 'Tangent',
  models: [
    { id: 'smart-model', label: 'Smart' },
    { id: 'fast-model', label: 'Simple' },
  ],
  defaultModel: 'smart-model',
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
    includedCreditCents: 200,
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
    createBranch: vi.fn(async (req: CreateBranchRequest) =>
      branch('side', {
        parentBranchId: 'trunk',
        branchPointNodeId: req.fromNodeId,
        anchorQuote: req.anchorQuote ?? null,
        model: req.model ?? 'smart-model',
      }),
    ),
    updateBranch: vi.fn(async (id: string, req: { model?: string }) =>
      branch(id, { model: req.model ?? 'smart-model' }),
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
  };
}

const POOL_STATUS: PoolStatusResponse = {
  enabled: true,
  fundingOpen: true,
  availableMicros: 0,
  sessionsRemaining: 0,
  model: { id: 'fast-model', label: 'Simple' },
  week: { start: T, exchanges: 0, learners: 0 },
  markupBps: 500,
  minPurchaseCents: 1000,
};

function setup() {
  const api = fakeApi();
  const router = { navigate: vi.fn(async (_commands: unknown[], _extras?: unknown) => true) };
  const injector = Injector.create({
    providers: [
      { provide: LessonStore },
      { provide: UiStore },
      { provide: AccountStore },
      { provide: PaymentStore },
      { provide: ApiClient, useValue: api },
      { provide: Router, useValue: router },
    ],
  });
  const store = injector.get(LessonStore);
  const ui = injector.get(UiStore);
  return { store, ui, api, router, injector };
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

  it('loads providers and exposes the Smart/Simple models', async () => {
    const s = setup();
    await s.store.init();
    expect(s.store.models().map((m) => m.label)).toEqual(['Smart', 'Simple']);
    expect(s.store.defaultModel()).toBe('smart-model');
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

    await vi.waitFor(() => expect(s.store.live().get('a1')?.status).toBe('Thinking…'));
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
          message: 'cancelled',
          node: { ...replyNode, status: 'error', error: 'cancelled', content: 'Li' },
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
    expect(stopped?.error).toBe('cancelled');
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
    expect(s.store.unsentDraft()).toEqual({ branchId: 'trunk', text: 'What is light?' });
    await vi.waitFor(() => expect(s.api.keyStatus).toHaveBeenCalled());
  });

  it('402 membership_required on send: blocks with the gate, no toast, keeps the message', async () => {
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
      supporter: false,
      supporterLimit: null,
    };
    s.api.sendMessage.mockRejectedValue(
      new ApiError(402, 'pool_empty', 'The community pool is empty', empty),
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
      supporter: false,
      supporterLimit: 150,
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
        supporter: false,
        supporterLimit: null,
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
      new ApiError(403, 'pool_consent_required', 'Read the notice', null, { currentVersion: newer }),
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
      new ApiError(403, 'pool_unavailable', 'Community pool access is suspended for this account'),
    );
    await s.store.send('trunk', 'What is light?');
    expect(s.ui.poolVerifyOpen()).toBe(false);
    expect(s.ui.toasts().at(-1)).toMatchObject({
      kind: 'error',
      text: 'Community pool access is suspended for this account',
    });
  });

  it('402 on the first message of a new lesson goes to billing too', async () => {
    const s = setup();
    await s.store.init();
    s.api.sendMessage.mockRejectedValue(new ApiError(402, 'payment_required', 'Too low'));
    await expect(s.store.startLesson('fast-model', '  Teach me fractions ')).resolves.toBe(true);

    expect(s.api.createTree).toHaveBeenCalledWith({ providerId: 'tangent', model: 'fast-model' });
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
    expect(s.store.unsentDraft()).toBeNull();
  });

  it('"Ask about this" branches with the quote, path context and the current model', async () => {
    const s = setup();
    const done = node('a1', { seq: 1, parentId: 'u1', content: 'Light is a wave.' });
    await open(s, detail([userNode, done], [branch('trunk', { model: 'fast-model' })]));
    const created = await s.store.askAbout('a1', 'a wave');

    expect(s.api.createBranch).toHaveBeenCalledWith({
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: 'a wave',
      providerId: 'tangent',
      model: 'fast-model',
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

  it('the Smart/Simple toggle updates the branch model', async () => {
    const s = setup();
    await open(s, detail());
    await expect(s.store.setModel('trunk', 'fast-model')).resolves.toBe(true);
    expect(s.api.updateBranch).toHaveBeenCalledWith('trunk', { model: 'fast-model' });
    expect(s.store.selectedBranch()?.model).toBe('fast-model');
    // No request when the model is already selected.
    await s.store.setModel('trunk', 'fast-model');
    expect(s.api.updateBranch).toHaveBeenCalledTimes(1);
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
});
