import type {
  Branch,
  ChatNode,
  CommitCandidateResponse,
  StreamEvent,
  TreeDetail,
  TreeSummary,
} from '@tangent/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../core/api-client';
import { ConversationStore, type FailedSend } from './conversation-store';

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
    model: 'a/b',
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

/** Tree `id`: a trunk with one exchange, and branch `side` off its reply. */
function tree(
  id = 't1',
  nodes: ChatNode[] = [],
  branches: Branch[] = [branch('trunk')],
): TreeDetail {
  return {
    tree: {
      id,
      accountId: 'u_1',
      title: 'Light',
      systemPrompt: null,
      trunkBranchId: 'trunk',
      createdAt: T,
      updatedAt: T,
    },
    branches,
    nodes,
    links: [],
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeApi() {
  return {
    listTrees: vi.fn(async (): Promise<TreeSummary[]> => []),
    getTree: vi.fn(async (_id: string) => tree()),
    createTree: vi.fn(async (_req: unknown) => tree('t2')),
    sendMessage: vi.fn(async (_b: string, _req: unknown, _signal: AbortSignal): Promise<Response> =>
      stream([]),
    ),
    streamNode: vi.fn(async (_id: string, _signal: AbortSignal): Promise<Response> => stream([])),
    cancelNode: vi.fn(async (_id: string) => undefined),
  };
}

/** The engine with the hooks an app would implement, recording what they are told. */
class TestStore extends ConversationStore<ReturnType<typeof fakeApi>> {
  readonly failures: unknown[] = [];
  readonly toasts: { text: string; kind: 'info' | 'error' | undefined }[] = [];
  readonly sentTexts: string[] = [];
  readonly failedSends: FailedSend[] = [];

  fail(err: unknown): void {
    this.failures.push(err);
  }

  protected notify(text: string, kind?: 'info' | 'error'): void {
    this.toasts.push({ text, kind });
  }

  protected override sent(_branchId: string, content: string): void {
    this.sentTexts.push(content);
  }

  protected override sendFailed(err: unknown, send: FailedSend): void {
    this.failedSends.push(send);
    super.sendFailed(err, send);
  }
}

function setup() {
  const api = fakeApi();
  const router = { navigate: vi.fn(async (_commands: unknown[], _extras?: unknown) => true) };
  const store = new TestStore(api, router, { treeMissing: 'This conversation does not exist.' });
  return { store, api, router };
}

/** Opens tree `d` at `branchId` and waits for it to load. */
async function open(
  s: ReturnType<typeof setup>,
  d: TreeDetail,
  branchId: string | null = null,
): Promise<void> {
  s.api.getTree.mockResolvedValue(d);
  s.store.setRoute(d.tree.id, branchId, null);
  await vi.waitFor(() => expect(s.store.detail()).not.toBeNull());
}

const userNode = node('u1', { role: 'user', content: 'What is light?' });
const replyNode = node('a1', { seq: 1, parentId: 'u1', status: 'streaming' });
const start: StreamEvent = {
  type: 'start',
  userNode,
  assistantNode: replyNode,
  branch: branch('trunk'),
};

describe('ConversationStore streaming a reply', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('applies start, status, delta and done events, then refreshes the list', async () => {
    const s = setup();
    await open(s, tree());
    const live = controlledStream([start, { type: 'status', message: 'Thinking…' }]);
    s.api.sendMessage.mockResolvedValue(live.response);
    const sending = s.store.send('trunk', 'What is light?', { ground: 'required' });
    expect(s.store.busy()).toBe(true);
    expect([...s.store.sending()]).toEqual(['trunk']);

    await vi.waitFor(() => expect(s.store.live().get('a1')?.status).toBe('Thinking…'));
    expect(s.store.sending().size).toBe(0);
    expect(s.store.streamingNode()?.id).toBe('a1');
    expect(s.store.busy()).toBe(true);
    expect(s.store.sentTexts).toEqual(['What is light?']);

    live.push([
      { type: 'delta', nodeId: 'a1', text: 'Light is ' },
      { type: 'delta', nodeId: 'a1', text: 'a wave.' },
    ]);
    await vi.waitFor(() => expect(s.store.live().get('a1')?.content).toBe('Light is a wave.'));
    expect(s.store.live().get('a1')?.status).toBeNull();

    s.api.listTrees.mockResolvedValue([
      { id: 't1', title: 'Waves', createdAt: T, updatedAt: T, branchCount: 1, messageCount: 2 },
    ]);
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
      { content: 'What is light?', ground: 'required' },
      expect.any(AbortSignal),
    );
    expect(s.store.path().map((n) => [n.id, n.status, n.content])).toEqual([
      ['u1', 'complete', 'What is light?'],
      ['a1', 'complete', 'Light is a wave.'],
    ]);
    expect(s.store.selectedBranch()?.title).toBe('Light');
    expect(s.store.live().size).toBe(0);
    expect(s.store.busy()).toBe(false);
    expect(s.store.completions()).toBe(1);
    // Auto-titling: the list and the open tree's title follow the server.
    await vi.waitFor(() => expect(s.store.detail()?.tree.title).toBe('Waves'));
    expect(s.store.trees().map((t) => t.title)).toEqual(['Waves']);
  });

  it('an error event with the node applies it; one without marks the reply failed, keeping its text', async () => {
    const s = setup();
    await open(s, tree());
    const live = controlledStream([start, { type: 'delta', nodeId: 'a1', text: 'Li' }]);
    s.api.sendMessage.mockResolvedValue(live.response);
    const sending = s.store.send('trunk', 'What is light?');
    await vi.waitFor(() => expect(s.store.live().get('a1')?.content).toBe('Li'));
    live.push([{ type: 'error', nodeId: 'a1', message: 'Provider down', node: null }]);
    live.close();
    await expect(sending).resolves.toBe(true);
    expect(s.store.index()?.nodes.get('a1')).toMatchObject({
      status: 'error',
      error: 'Provider down',
      content: 'Li',
    });
    expect(s.store.live().size).toBe(0);
    expect(s.store.failures).toEqual([]);
  });

  it('Stop cancels on the server; the closing error event ends the reply', async () => {
    const s = setup();
    await open(s, tree());
    const live = controlledStream([start, { type: 'delta', nodeId: 'a1', text: 'Li' }]);
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
    expect(s.store.index()?.nodes.get('a1')).toMatchObject({
      status: 'error',
      error: 'Cancelled',
      content: 'Li',
    });
    expect(s.store.streamingNode()).toBeNull();
    expect(s.store.busy()).toBe(false);
  });

  it('a refused Stop goes to the error policy', async () => {
    const s = setup();
    const refused = new ApiError(500, 'internal', 'boom');
    s.api.cancelNode.mockRejectedValue(refused);
    await s.store.cancel('a1');
    expect(s.store.failures).toEqual([refused]);
  });

  it('reconnects when the stream drops, shows it, and finishes from the snapshot', async () => {
    const s = setup();
    await open(s, tree());
    s.api.sendMessage.mockResolvedValue(
      stream([start, { type: 'delta', nodeId: 'a1', text: 'Li' }]),
    );
    const again = deferred<Response>();
    s.api.streamNode.mockReturnValue(again.promise);
    const sending = s.store.send('trunk', 'What is light?');
    await vi.waitFor(() => expect(s.store.live().get('a1')?.reconnecting).toBe(true));
    expect(s.store.live().get('a1')?.content).toBe('Li');
    await vi.waitFor(() =>
      expect(s.api.streamNode).toHaveBeenCalledWith('a1', expect.any(AbortSignal)),
    );

    const resumed = controlledStream([
      { type: 'snapshot', node: { ...replyNode, content: 'Light is' } },
    ]);
    again.resolve(resumed.response);
    await vi.waitFor(() => expect(s.store.live().get('a1')?.content).toBe('Light is'));
    expect(s.store.live().get('a1')?.reconnecting).toBe(false);
    resumed.push([
      { type: 'delta', nodeId: 'a1', text: ' fast.' },
      {
        type: 'done',
        node: { ...replyNode, status: 'complete', content: 'Light is fast.' },
        branch: branch('trunk'),
      },
    ]);
    resumed.close();
    await expect(sending).resolves.toBe(true);
    expect(s.store.index()?.nodes.get('a1')?.content).toBe('Light is fast.');
    expect(s.store.live().size).toBe(0);
  });

  it('a connection that cannot be recovered marks the reply failed (lost), keeping its text', async () => {
    const s = setup();
    await open(s, tree());
    s.api.sendMessage.mockResolvedValue(
      stream([start, { type: 'delta', nodeId: 'a1', text: 'Li' }]),
    );
    s.api.streamNode.mockRejectedValue(new ApiError(404, 'not_found', 'gone'));
    await expect(s.store.send('trunk', 'What is light?')).resolves.toBe(true);
    expect(s.store.index()?.nodes.get('a1')).toMatchObject({
      status: 'error',
      error: 'Connection lost. Reload to see the final reply.',
      content: 'Li',
    });
    expect(s.store.live().size).toBe(0);
    expect(s.store.busy()).toBe(false);
    expect(s.store.toasts).toEqual([
      { text: 'Lost the connection to the reply: gone. Reload to check on it.', kind: 'error' },
    ]);
    expect(s.store.completions()).toBe(1);
  });

  it('a send refused before its reply starts tells sendFailed so, and ends the send', async () => {
    const s = setup();
    await open(s, tree());
    const refused = new ApiError(402, 'payment_required', 'Not enough credit');
    s.api.sendMessage.mockRejectedValue(refused);
    await expect(s.store.send('trunk', 'Hi', { ground: 'required' })).resolves.toBe(false);
    expect(s.store.failedSends).toEqual([
      { branchId: 'trunk', content: 'Hi', options: { ground: 'required' }, started: false },
    ]);
    expect(s.store.failures).toEqual([refused]);
    expect(s.store.sending().size).toBe(0);
    expect(s.store.busy()).toBe(false);
  });

  it('a send on another branch leaves the first branch busy until its reply starts', async () => {
    const s = setup();
    const side = branch('side', { parentBranchId: 'trunk', branchPointNodeId: 'a1' });
    const reply = node('a1', { seq: 1, parentId: 'u1', content: 'A wave.' });
    await open(s, tree('t1', [userNode, reply], [branch('trunk'), side]), 'side');
    const posts = new Map<string, (r: Response) => void>();
    s.api.sendMessage.mockImplementation(
      (branchId: string) => new Promise<Response>((r) => posts.set(branchId, r)),
    );

    void s.store.send('side', 'One');
    expect(s.store.busy()).toBe(true);
    const other = s.store.send('trunk', 'Two');
    expect(s.store.busy()).toBe(true);
    // The other branch's POST ends (refused here) while the first is still out.
    posts.get('trunk')?.(new Response('nope', { status: 500 }));
    await other;
    expect(s.store.busy()).toBe(true);
    expect([...s.store.sending()]).toEqual(['side']);
  });

  it('a committed Compare pick joins the tree as a finished reply', async () => {
    const s = setup();
    await open(s, tree());
    const committed: CommitCandidateResponse = {
      userNode,
      assistantNode: { ...replyNode, status: 'complete', content: 'A wave.' },
      branch: branch('trunk', { title: 'Light' }),
    };
    s.store.applyCommitted(committed);
    expect(s.store.path().map((n) => [n.id, n.status])).toEqual([
      ['u1', 'complete'],
      ['a1', 'complete'],
    ]);
    expect(s.store.selectedBranch()?.title).toBe('Light');
    expect(s.store.live().size).toBe(0);
    expect(s.store.completions()).toBe(1);
    await vi.waitFor(() => expect(s.api.listTrees).toHaveBeenCalled());
  });
});

describe('ConversationStore re-attaching to replies when a tree opens', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('follows a reply still generating to its end', async () => {
    const s = setup();
    const reached = deferred<Response>();
    s.api.streamNode.mockReturnValue(reached.promise);
    await open(s, tree('t1', [userNode, { ...replyNode, content: 'Ha' }]));
    expect(s.store.live().get('a1')?.content).toBe('Ha');
    const again = controlledStream([{ type: 'snapshot', node: { ...replyNode, content: 'Half' } }]);
    reached.resolve(again.response);
    await vi.waitFor(() => expect(s.store.live().get('a1')?.content).toBe('Half'));
    expect(s.store.busy()).toBe(true);
    again.push([
      {
        type: 'done',
        node: { ...replyNode, status: 'complete', content: 'Half done.' },
        branch: branch('trunk'),
      },
    ]);
    again.close();
    await vi.waitFor(() => expect(s.store.index()?.nodes.get('a1')?.content).toBe('Half done.'));
    expect(s.api.streamNode).toHaveBeenCalledWith('a1', expect.any(AbortSignal));
    expect(s.store.live().size).toBe(0);
    expect(s.store.completions()).toBe(1);
  });

  it('a reload while one is followed does not follow it twice', async () => {
    const s = setup();
    s.api.streamNode.mockReturnValue(new Promise<Response>(() => undefined));
    await open(s, tree('t1', [userNode, replyNode]));
    await s.store.loadTree('t1', true);
    expect(s.api.streamNode).toHaveBeenCalledTimes(1);
  });

  it('one that cannot be reached is marked lost', async () => {
    const s = setup();
    s.api.streamNode.mockRejectedValue(new ApiError(404, 'not_found', 'gone'));
    await open(s, tree('t1', [userNode, { ...replyNode, content: 'Ha' }]));
    await vi.waitFor(() => expect(s.store.index()?.nodes.get('a1')?.status).toBe('error'));
    expect(s.store.index()?.nodes.get('a1')?.content).toBe('Ha');
    expect(s.store.live().size).toBe(0);
    expect(s.store.toasts.at(-1)?.text).toContain('Lost the connection');
  });
});
