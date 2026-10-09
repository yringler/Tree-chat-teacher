import type {
  Branch,
  ChatNode,
  CommitCandidateResponse,
  CreateBranchRequest,
  CreateLinkRequest,
  DeleteBranchResponse,
  StreamEvent,
  TreeDetail,
  TreeSummary,
  UpdateBranchRequest,
  UpdateTreeRequest,
} from '@tangent/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../core/api-client';
import { ConversationStore, type FailedSend } from './conversation-store';
import { branch, controlledStream, deferred, detail, link, node, stream, T } from '../testing';

/** Tree `id` with these messages and branches. */
const tree = (
  id = 't1',
  nodes: ChatNode[] = [],
  branches: Branch[] = [branch('trunk')],
): TreeDetail => detail(nodes, branches, [], { id });

function fakeApi() {
  return {
    listTrees: vi.fn(async (): Promise<TreeSummary[]> => []),
    getTree: vi.fn(async (_id: string) => tree()),
    createTree: vi.fn(async (_req: unknown) => tree('t2')),
    importBackup: vi.fn(async (_backup: unknown) => tree('t3')),
    sendMessage: vi.fn(async (_b: string, _req: unknown, _signal: AbortSignal): Promise<Response> =>
      stream([]),
    ),
    streamNode: vi.fn(async (_id: string, _signal: AbortSignal): Promise<Response> => stream([])),
    cancelNode: vi.fn(async (_id: string) => undefined),
    deleteTree: vi.fn(async (_id: string) => undefined),
    updateTree: vi.fn(async (id: string, _req: UpdateTreeRequest) => tree(id).tree),
    createBranch: vi.fn(async (req: CreateBranchRequest): Promise<Branch> =>
      branch('new', {
        parentBranchId: 'trunk',
        branchPointNodeId: req.fromNodeId,
        title: req.title ?? 'Branch',
      }),
    ),
    updateBranch: vi.fn(async (id: string, req: UpdateBranchRequest) =>
      branch(id, { model: req.model ?? 'a/b' }),
    ),
    deleteBranch: vi.fn(async (_id: string): Promise<DeleteBranchResponse> => ({
      treeId: 't1',
      branchIds: ['side', 'deep'],
      nodeIds: ['u2', 'a2', 'u3'],
    })),
    createLink: vi.fn(async (req: CreateLinkRequest) => ({
      link: link('l-new', req.fromNodeId, req.toNodeId, req.note ?? null),
      created: true,
    })),
    updateLink: vi.fn(async (id: string, req: { note: string | null }) =>
      link(id, 'a1', 'a2', req.note),
    ),
    deleteLink: vi.fn(async (_id: string) => undefined),
  };
}

/** The engine with the hooks an app would implement, recording what they are told. */
class TestStore extends ConversationStore<ReturnType<typeof fakeApi>> {
  readonly failures: unknown[] = [];
  readonly toasts: { text: string; kind: 'info' | 'error' | undefined }[] = [];
  readonly sentTexts: string[] = [];
  readonly failedSends: FailedSend[] = [];
  readonly removed: { branchIds: string[]; nodeIds: string[] }[] = [];
  readonly deletedTrees: string[] = [];
  readonly droppedLinks: string[] = [];
  readonly treeChanges: (string | null)[] = [];
  alsoRefreshed = 0;

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

  protected override alsoRefreshAfterReply(): Promise<unknown> | null {
    this.alsoRefreshed++;
    return null;
  }

  protected override branchesRemoved(
    branchIds: ReadonlySet<string>,
    nodeIds: ReadonlySet<string>,
  ): void {
    this.removed.push({ branchIds: [...branchIds], nodeIds: [...nodeIds] });
  }

  protected override treeDeleted(treeId: string): void {
    this.deletedTrees.push(treeId);
  }

  protected override linkDropped(linkId: string): void {
    this.droppedLinks.push(linkId);
  }

  protected override treeChanged(): void {
    this.treeChanges.push(this.selectedTreeId());
  }

  /** New branches keep the model of the branch they come from. */
  protected override newBranchRoute(from: Branch | null): Partial<CreateBranchRequest> {
    return from ? { model: from.model } : {};
  }

  /** What an app's "new conversation" does first. */
  start(): Promise<TreeDetail> {
    return this.openNewTree({});
  }
}

function setup() {
  const api = fakeApi();
  const router = { navigate: vi.fn(async (_commands: unknown[], _extras?: unknown) => true) };
  const store = new TestStore(api, router, {
    tree: 'conversation',
    branch: 'side question',
    link: 'link',
    linked: { created: 'Messages linked', existing: 'Already linked' },
  });
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
  funding: 'own-key',
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

/**
 * trunk: u1 a1; `side` from a1 (u2 a2) with `deep` below it from a2 (u3);
 * `other` from a1 (u4). Links: a1 ↔ a2, u1 ↔ a1, u3 ↔ u1.
 */
function branchy(): TreeDetail {
  return {
    ...tree(
      't1',
      [
        node('u1', { role: 'user', content: 'What is light?' }),
        node('a1', { seq: 1, parentId: 'u1', content: 'A wave.' }),
        node('u2', { seq: 2, parentId: 'a1', branchId: 'side', role: 'user', content: 'And?' }),
        node('a2', { seq: 3, parentId: 'u2', branchId: 'side', content: 'A particle.' }),
        node('u3', { seq: 4, parentId: 'a2', branchId: 'deep', role: 'user', content: 'Both?' }),
        node('u4', { seq: 2, parentId: 'a1', branchId: 'other', role: 'user', content: 'Why?' }),
      ],
      [
        branch('trunk'),
        branch('side', { parentBranchId: 'trunk', branchPointNodeId: 'a1', model: 'side/model' }),
        branch('deep', { parentBranchId: 'side', branchPointNodeId: 'a2' }),
        branch('other', { parentBranchId: 'trunk', branchPointNodeId: 'a1' }),
      ],
    ),
    links: [link('l1', 'a1', 'a2', 'Same idea'), link('l2', 'u1', 'a1'), link('l3', 'u3', 'u1')],
  };
}

/** The store showing `branchy()` at `selected`. */
function showing(selected: string | null = null) {
  const s = setup();
  s.store.detail.set(branchy());
  s.store.setRoute('t1', selected, null);
  const go = vi.spyOn(s.store, 'go');
  return { ...s, go };
}

const summary = (id: string, title: string): TreeSummary => ({
  id,
  title,
  createdAt: T,
  updatedAt: T,
  branchCount: 4,
  messageCount: 6,
});

describe('ConversationStore loading and routing', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  /** Tree t1 asked for, its answer held back. */
  function slowLoad() {
    const s = setup();
    const pending = deferred<TreeDetail>();
    s.api.getTree.mockReturnValue(pending.promise);
    s.store.setRoute('t1', null, null);
    expect(s.store.detailLoading()).toBe(true);
    return { ...s, pending };
  }

  it('selects the branch in the URL while the tree has it, else the trunk', () => {
    const s = showing('deep');
    expect(s.store.selectedBranchId()).toBe('deep');
    expect(s.store.chain().map((b) => b.id)).toEqual(['trunk', 'side', 'deep']);
    expect(s.store.path().map((n) => n.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3']);
    expect(s.store.parentBranch()?.id).toBe('side');
    expect(s.store.leaf()?.id).toBe('u3');
    expect(s.store.depthOf('deep')).toBe(2);
    expect(s.store.childBranchesAt('a1').map((b) => b.id)).toEqual(['other', 'side']);
    s.store.setRoute('t1', 'gone', null);
    expect(s.store.selectedBranchId()).toBe('trunk');
    expect(s.store.parentBranch()).toBeNull();
  });

  it('go: the trunk is the tree’s own URL unless a message is focused', () => {
    const s = showing();
    s.store.go('trunk');
    expect(s.router.navigate).toHaveBeenLastCalledWith(['/t', 't1'], {
      queryParams: {},
      replaceUrl: false,
    });
    s.store.go('trunk', 'a1', true);
    expect(s.router.navigate).toHaveBeenLastCalledWith(['/t', 't1', 'b', 'trunk'], {
      queryParams: { m: 'a1' },
      replaceUrl: true,
    });
    s.store.setRoute('t1', 'side', null);
    expect(s.store.navigate('parent')).toBe(true);
    expect(s.router.navigate).toHaveBeenLastCalledWith(['/t', 't1', 'b', 'trunk'], {
      queryParams: { m: 'a1' },
      replaceUrl: false,
    });
  });

  it('tells the app when the open tree changes, and only then', () => {
    const s = showing('side');
    expect(s.store.treeChanges).toEqual(['t1']);
    s.store.setRoute('t1', 'deep', 'u3');
    expect(s.store.treeChanges).toEqual(['t1']);
    s.store.setRoute(null, null, null);
    expect(s.store.treeChanges).toEqual(['t1', null]);
  });

  it('a tree the server does not know says so in the app’s words', async () => {
    const s = setup();
    s.api.getTree.mockRejectedValue(new ApiError(404, 'not_found', 'Not found'));
    s.store.setRoute('t9', null, null);
    await vi.waitFor(() => expect(s.store.detailError()).toBe('This conversation does not exist.'));
    expect(s.store.detailLoading()).toBe(false);
  });

  it('a load that lands after going home: home stays empty', async () => {
    const s = slowLoad();
    s.store.setRoute(null, null, null);
    expect(s.store.detailLoading()).toBe(false);
    s.pending.resolve(tree());
    await s.pending.promise;
    await Promise.resolve();
    expect(s.store.detail()).toBeNull();
    expect(s.store.detailLoading()).toBe(false);
  });

  it('a load that lands after a new tree opened: the new one stays open', async () => {
    const s = slowLoad();
    await s.store.start();
    expect(s.router.navigate).toHaveBeenCalledWith(['/t', 't2']);
    s.pending.resolve(tree());
    await s.pending.promise;
    await Promise.resolve();
    expect(s.store.detail()?.tree.id).toBe('t2');
    expect(s.store.detailLoading()).toBe(false);
    expect(s.store.selectedBranchId()).toBe('trunk');
    expect(s.store.trees().map((t) => t.id)).toEqual(['t2']);
  });

  it('a failure that lands after another tree opened is not shown on it', async () => {
    const s = slowLoad();
    s.api.getTree.mockResolvedValue(tree('t2'));
    s.store.setRoute('t2', null, null);
    s.pending.reject(new ApiError(500, 'internal', 'boom'));
    await vi.waitFor(() => expect(s.store.detail()?.tree.id).toBe('t2'));
    expect(s.store.detailError()).toBeNull();
  });
});

describe('ConversationStore moving around the tree', () => {
  it('lists the chain as crumbs, each going back to where the next branch forks off', () => {
    const s = showing('deep');
    expect(s.store.crumbs().map((c) => [c.branch.id, c.focusNodeId, c.current])).toEqual([
      ['trunk', 'a1', false],
      ['side', 'a2', false],
      ['deep', null, true],
    ]);
    expect([...s.store.chainIds()]).toEqual(['trunk', 'side', 'deep']);
  });

  it('lists every branch in the outline, depth first', () => {
    const s = showing();
    expect(s.store.flatOutline().map((o) => [o.branch.id, o.depth])).toEqual([
      ['trunk', 0],
      ['other', 1],
      ['side', 1],
      ['deep', 2],
    ]);
  });

  it('marks fork dividers and ancestor messages along the path', () => {
    const s = showing('deep');
    expect(
      s.store.pathEntries().map((e) => [e.node.id, e.ancestor, e.divider?.id ?? null]),
    ).toEqual([
      ['u1', true, null],
      ['a1', true, null],
      ['u2', true, 'side'],
      ['a2', true, null],
      ['u3', false, 'deep'],
    ]);
    expect(s.store.emptyBranch()).toBeNull();
  });

  it('keeps the focus only while the message is on the path', () => {
    const s = showing();
    s.store.setRoute('t1', 'deep', 'a1');
    expect(s.store.focusedInPath()?.id).toBe('a1');
    s.store.setRoute('t1', 'deep', 'u4');
    expect(s.store.focusedInPath()).toBeNull();
  });

  it('moves the focus along the path, and says when it could not', () => {
    const s = showing('deep');
    expect(s.store.moveFocus(1)).toBe(true);
    expect(s.go).toHaveBeenLastCalledWith('deep', 'u1', true);
    expect(s.store.moveFocus(-1)).toBe(true);
    expect(s.go).toHaveBeenLastCalledWith('deep', 'u3', true);
    s.store.setRoute('t1', 'deep', 'u3');
    expect(s.store.moveFocus(1)).toBe(false);
    s.store.setRoute('t1', 'deep', 'u1');
    expect(s.store.moveFocus(-1)).toBe(false);
    expect(setup().store.moveFocus(1)).toBe(false);
  });

  it('opens a branch at its first message, or where it ends while it has none', () => {
    const s = showing();
    s.store.openAtStart('side');
    expect(s.go).toHaveBeenLastCalledWith('side', 'u2');
    s.store.openAtStart('nowhere');
    expect(s.go).toHaveBeenLastCalledWith('nowhere', null);
  });

  it('opens a tangent already followed at its first message', async () => {
    const s = showing();
    await s.store.followTangent('a1', 'other');
    expect(s.api.createBranch).not.toHaveBeenCalled();
    expect(s.go).toHaveBeenLastCalledWith('other', 'u4');
  });
});

describe('ConversationStore the tree list', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  /** Every list read held back, in order. */
  function heldReads(s: ReturnType<typeof setup>) {
    const reads: ((list: TreeSummary[]) => void)[] = [];
    s.api.listTrees.mockImplementation(() => new Promise<TreeSummary[]>((r) => reads.push(r)));
    return reads;
  }

  /** `n` replies finishing at once (Compare picks: no stream to wait for). */
  function finished(s: ReturnType<typeof setup>, n: number) {
    for (let i = 0; i < n; i++) {
      s.store.applyCommitted({
        userNode: node(`ask-${i}`, { seq: 9 + 2 * i, role: 'user' }),
        assistantNode: node(`done-${i}`, { seq: 10 + 2 * i, parentId: `ask-${i}` }),
        branch: branch('trunk'),
      });
    }
  }

  it('a failed read goes to the error policy; the list counts as loaded', async () => {
    const s = setup();
    const refused = new ApiError(500, 'internal', 'boom');
    s.api.listTrees.mockRejectedValue(refused);
    await s.store.loadTrees();
    expect(s.store.failures).toEqual([refused]);
    expect(s.store.treesLoaded()).toBe(true);
  });

  it('six replies finishing together read the list twice at most, and the latest answer stays', async () => {
    const s = showing();
    const reads = heldReads(s);
    finished(s, 6);
    expect(reads).toHaveLength(1);
    reads[0]!([summary('t1', 'Light')]);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]!([summary('t1', 'Light and waves')]);
    await vi.waitFor(() => expect(s.store.detail()?.tree.title).toBe('Light and waves'));
    expect(reads).toHaveLength(2);
    expect(s.store.trees().map((t) => t.title)).toEqual(['Light and waves']);
  });

  it('what the app refreshes after a reply goes alongside the list, in the same batch', async () => {
    const s = showing();
    const reads = heldReads(s);
    finished(s, 3);
    expect(s.store.alsoRefreshed).toBe(1);
    reads[0]!([]);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(s.store.alsoRefreshed).toBe(2);
  });

  it('a refresh that hangs is left to itself after 20 seconds', () => {
    vi.useFakeTimers();
    try {
      const s = showing();
      const reads = heldReads(s);
      finished(s, 1);
      finished(s, 1);
      expect(reads).toHaveLength(1);
      vi.advanceTimersByTime(21_000);
      finished(s, 1);
      expect(reads).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an older read answering last does not overwrite a newer one', async () => {
    const s = setup();
    const reads = heldReads(s);
    const first = s.store.loadTrees();
    const second = s.store.loadTrees();
    reads[1]!([summary('t1', 'New')]);
    await second;
    reads[0]!([summary('t1', 'Old')]);
    await first;
    expect(s.store.trees().map((t) => t.title)).toEqual(['New']);
  });

  it('a read sent before a delete or a new tree does not undo them', async () => {
    const s = setup();
    const reads = heldReads(s);
    s.store.trees.set([summary('t1', 'Light')]);
    const before = s.store.loadTrees();
    await s.store.deleteTree('t1');
    expect(s.store.trees()).toEqual([]);
    reads[0]!([summary('t1', 'Light')]);
    await before;
    expect(s.store.trees()).toEqual([]);

    const again = s.store.loadTrees();
    await s.store.start();
    reads[1]!([]);
    await again;
    expect(s.store.trees().map((t) => t.id)).toEqual(['t2']);
  });

  it('a failed refresh after a reply is quiet', async () => {
    const s = showing();
    s.api.listTrees.mockRejectedValue(new ApiError(500, 'internal', 'boom'));
    finished(s, 1);
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(s.store.toasts).toEqual([]);
    expect(s.store.failures).toEqual([]);
  });
});

describe('ConversationStore deleting a tree', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('the open tree goes from the list, the app is told, and home is shown', async () => {
    const s = showing();
    s.store.trees.set([summary('t1', 'Light'), summary('t2', 'Owls')]);
    await expect(s.store.deleteTree('t1')).resolves.toBe(true);
    expect(s.api.deleteTree).toHaveBeenCalledWith('t1');
    expect(s.store.trees().map((t) => t.id)).toEqual(['t2']);
    expect(s.store.deletedTrees).toEqual(['t1']);
    expect(s.router.navigate).toHaveBeenCalledWith(['/']);
    expect(s.store.toasts).toEqual([{ text: 'Conversation deleted', kind: undefined }]);
  });

  it('stops following its replies', async () => {
    const s = setup();
    const signals: AbortSignal[] = [];
    s.api.streamNode.mockImplementation((_id: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<Response>(() => undefined);
    });
    await open(s, tree('t1', [userNode, replyNode]));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(s.store.live().has('a1')).toBe(true);
    await expect(s.store.deleteTree('t1')).resolves.toBe(true);
    expect(signals[0]?.aborted).toBe(true);
    expect(s.store.live().size).toBe(0);
  });

  it('a refused delete keeps everything', async () => {
    const s = showing();
    s.store.trees.set([summary('t1', 'Light')]);
    const refused = new ApiError(500, 'internal', 'boom');
    s.api.deleteTree.mockRejectedValue(refused);
    await expect(s.store.deleteTree('t1')).resolves.toBe(false);
    expect(s.store.trees()).toHaveLength(1);
    expect(s.store.deletedTrees).toEqual([]);
    expect(s.store.failures).toEqual([refused]);
  });
});

describe('ConversationStore branches', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('startBranch creates the branch, opens it and sends its first message', async () => {
    const s = showing();
    const req = { fromNodeId: 'a1', contextMode: 'path', anchorQuote: null } as const;
    const made = await s.store.startBranch(req, 'Why?');
    expect(made?.id).toBe('new');
    // On the app's route after the message's branch (`newBranchRoute`), the request naming none.
    expect(s.api.createBranch).toHaveBeenCalledWith({ ...req, model: 'a/b' });
    expect(s.store.index()?.branches.has('new')).toBe(true);
    expect(s.go).toHaveBeenCalledWith('new');
    expect(s.api.sendMessage).toHaveBeenCalledWith(
      'new',
      { content: 'Why?' },
      expect.any(AbortSignal),
    );
  });

  it("a request that names a provider keeps its own route, not the app's", async () => {
    const s = showing();
    const req = {
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: null,
      providerId: 'anthropic',
      model: 'claude',
    } as const;
    await s.store.createBranch(req);
    expect(s.api.createBranch).toHaveBeenCalledWith(req);
    expect(s.go).toHaveBeenCalledWith('new');
  });

  it('follows a tangent once: a titled path branch asking it, then just its branch', async () => {
    const s = showing();
    await s.store.followTangent('a1', 'Why waves?');
    expect(s.api.createBranch).toHaveBeenCalledWith({
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: null,
      title: 'Why waves?',
      model: 'a/b',
    });
    expect(s.api.sendMessage).toHaveBeenCalledWith(
      'new',
      { content: 'Why waves?' },
      expect.any(AbortSignal),
    );
    s.api.createBranch.mockClear();
    expect((await s.store.followTangent('a1', 'Why waves?'))?.id).toBe('new');
    expect(s.api.createBranch).not.toHaveBeenCalled();
    // It has no message in the tree yet: it opens where it ends.
    expect(s.go).toHaveBeenLastCalledWith('new', null);
  });

  it("imports a backup, lists it and opens it, in the app's words", async () => {
    const s = showing();
    const detail = await s.store.importTree({
      format: 'tangent-tree-backup',
      version: 1,
      exportedAt: T,
      tree: {
        id: 't3',
        title: 'Old',
        systemPrompt: null,
        trunkBranchId: 'b3',
        createdAt: T,
        updatedAt: T,
      },
      branches: [],
      nodes: [],
      links: [],
    });
    expect(detail?.tree.id).toBe('t3');
    expect(s.store.trees().map((t) => t.id)).toContain('t3');
    expect(s.store.toasts.at(-1)?.text).toMatch(/^Imported “/);
    expect(s.router.navigate).toHaveBeenCalledWith(['/t', 't3']);
  });

  it('a branch that cannot be created sends nothing', async () => {
    const s = showing();
    const refused = new ApiError(500, 'internal', 'Nope');
    s.api.createBranch.mockRejectedValueOnce(refused);
    await expect(
      s.store.startBranch({ fromNodeId: 'a1', contextMode: 'path', anchorQuote: null }, 'Why?'),
    ).resolves.toBeNull();
    expect(s.api.sendMessage).not.toHaveBeenCalled();
    expect(s.go).not.toHaveBeenCalled();
    expect(s.store.failures).toEqual([refused]);
  });

  it('updateBranch puts the server’s branch in the tree', async () => {
    const s = showing();
    const side = branchy().branches.find((b) => b.id === 'side')!;
    s.api.updateBranch.mockResolvedValueOnce({ ...side, model: 'x/y' });
    await expect(s.store.updateBranch('side', { model: 'x/y' })).resolves.toBe(true);
    expect(s.store.index()?.branches.get('side')?.model).toBe('x/y');
    s.api.updateBranch.mockRejectedValueOnce(new ApiError(400, 'bad_request', 'No'));
    await expect(s.store.updateBranch('side', { model: 'z/z' })).resolves.toBe(false);
    expect(s.store.failures).toHaveLength(1);
  });

  it('deleting the branch the selection is in (or above it) moves to the message it came from', async () => {
    const s = showing('deep');
    s.store.trees.set([summary('t1', 'Light')]);
    await expect(s.store.deleteBranch('side')).resolves.toBe(true);
    expect(s.api.deleteBranch).toHaveBeenCalledWith('side');
    expect(s.go).toHaveBeenCalledWith('trunk', 'a1', true);
    const idx = s.store.index();
    expect([...(idx?.branches.keys() ?? [])].sort()).toEqual(['other', 'trunk']);
    expect(idx?.nodes.has('u3')).toBe(false);
    expect(s.store.childBranchesAt('a1').map((b) => b.id)).toEqual(['other']);
    // The server dropped the links touching them with them.
    expect(s.store.links().map((l) => l.id)).toEqual(['l2']);
    expect(s.store.removed).toEqual([{ branchIds: ['side', 'deep'], nodeIds: ['u2', 'a2', 'u3'] }]);
    expect(s.store.trees()[0]).toMatchObject({ branchCount: 2, messageCount: 3 });
    expect(s.store.toasts.at(-1)?.text).toBe('Deleted the side question and 1 below it');
  });

  it('one branch alone is named so; a selection elsewhere stays where it is', async () => {
    const s = showing('other');
    s.api.deleteBranch.mockResolvedValueOnce({
      treeId: 't1',
      branchIds: ['deep'],
      nodeIds: ['u3'],
    });
    await s.store.deleteBranch('deep');
    expect(s.go).not.toHaveBeenCalled();
    expect(s.store.selectedBranchId()).toBe('other');
    expect(s.store.toasts.at(-1)?.text).toBe('Side question deleted');
  });

  it('replies generating in deleted branches stop being followed', async () => {
    const s = setup();
    const generating = branchy();
    generating.nodes = generating.nodes.map((n) =>
      n.id === 'a2' ? { ...n, status: 'streaming' } : n,
    );
    const signals: AbortSignal[] = [];
    s.api.streamNode.mockImplementation((_id: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<Response>(() => undefined);
    });
    await open(s, generating);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    await s.store.deleteBranch('side');
    expect(signals[0]?.aborted).toBe(true);
    expect(s.store.live().size).toBe(0);
  });

  it('a refused delete leaves everything as it was', async () => {
    const s = showing('side');
    const refused = new ApiError(409, 'conflict', 'Still generating');
    s.api.deleteBranch.mockRejectedValueOnce(refused);
    await expect(s.store.deleteBranch('side')).resolves.toBe(false);
    expect(s.go).not.toHaveBeenCalled();
    expect(s.store.index()?.branches.size).toBe(4);
    expect(s.store.selectedBranchId()).toBe('side');
    expect(s.store.removed).toEqual([]);
    expect(s.store.failures).toEqual([refused]);
  });
});

describe('ConversationStore Check sources', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('after the open branch’s last reply, appends the check there, quoting the question', async () => {
    const s = showing('side');
    await expect(s.store.checkSources('a2')).resolves.toBe(true);
    expect(s.api.createBranch).not.toHaveBeenCalled();
    expect(s.api.sendMessage).toHaveBeenCalledWith(
      'side',
      expect.objectContaining({ ground: 'required', content: expect.stringContaining('And?') }),
      expect.any(AbortSignal),
    );
  });

  it('on an ancestor branch’s last reply, opens a branch from it where the check streams', async () => {
    const s = showing('side');
    await s.store.checkSources('a1');
    expect(s.api.createBranch).toHaveBeenCalledWith({
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: null,
      title: 'Checking sources',
      // The app's route for a branch off the trunk (`newBranchRoute`).
      model: 'a/b',
    });
    expect(s.go).toHaveBeenCalledWith('new');
    expect(s.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(s.api.sendMessage).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({ ground: 'required' }),
      expect.any(AbortSignal),
    );
  });

  it('checks only replies', async () => {
    const s = showing();
    await expect(s.store.checkSources('u1')).resolves.toBe(false);
    await expect(s.store.checkSources('gone')).resolves.toBe(false);
    expect(s.api.sendMessage).not.toHaveBeenCalled();
  });
});

describe('ConversationStore links between messages', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('indexes the links under both of their ends', () => {
    const s = showing();
    expect(s.store.links().map((l) => l.id)).toEqual(['l1', 'l2', 'l3']);
    expect(
      s.store
        .linksByNode()
        .get('a1')
        ?.map((l) => l.id),
    ).toEqual(['l1', 'l2']);
    expect(
      s.store
        .linksByNode()
        .get('u3')
        ?.map((l) => l.id),
    ).toEqual(['l3']);
    expect(s.store.linksByNode().has('u2')).toBe(false);
  });

  it('creates a link, adds it to the tree and says so', async () => {
    const s = showing();
    const made = await s.store.createLink('u4', 'u1', 'Same question');
    expect(s.api.createLink).toHaveBeenCalledWith({
      fromNodeId: 'u4',
      toNodeId: 'u1',
      note: 'Same question',
    });
    expect(made?.id).toBe('l-new');
    expect(s.store.links().map((l) => l.id)).toEqual(['l1', 'l2', 'l3', 'l-new']);
    expect(s.store.linksByNode().get('u4')?.[0]?.note).toBe('Same question');
    expect(s.store.toasts.at(-1)?.text).toBe('Messages linked');
  });

  it('a pair already linked (either way round) keeps its one link', async () => {
    const s = showing();
    s.api.createLink.mockResolvedValueOnce({
      link: link('l1', 'a1', 'a2', 'Same idea'),
      created: false,
    });
    await s.store.createLink('a2', 'a1');
    expect(s.store.links().map((l) => l.id)).toEqual(['l1', 'l2', 'l3']);
    expect(s.store.toasts.at(-1)?.text).toBe('Already linked');
  });

  it('trusts the server over a stale local index (linked in another tab)', async () => {
    const s = showing();
    s.api.createLink.mockResolvedValueOnce({ link: link('l9', 'u4', 'u2'), created: false });
    await s.store.createLink('u2', 'u4');
    expect(s.store.links().map((l) => l.id)).toEqual(['l1', 'l2', 'l3', 'l9']);
    expect(s.store.toasts.at(-1)?.text).toBe('Already linked');
  });

  it('a link of another tree (opened meanwhile) is not applied', async () => {
    const s = showing();
    const elsewhere = { ...link('l9', 'x1', 'x2'), treeId: 't2' };
    s.api.createLink.mockResolvedValueOnce({ link: elsewhere, created: true });
    await s.store.createLink('u4', 'u1');
    expect(s.store.links().map((l) => l.id)).toEqual(['l1', 'l2', 'l3']);
  });

  it('a refused link changes nothing and goes to the error policy', async () => {
    const s = showing();
    const refused = new ApiError(400, 'bad_request', 'Too many links');
    s.api.createLink.mockRejectedValueOnce(refused);
    await expect(s.store.createLink('u4', 'u1')).resolves.toBeNull();
    expect(s.store.links()).toHaveLength(3);
    expect(s.store.failures).toEqual([refused]);
  });

  it('edits a note, and removes a link from both of its ends', async () => {
    const s = showing();
    await expect(s.store.updateLinkNote('l1', null)).resolves.toBe(true);
    expect(s.api.updateLink).toHaveBeenCalledWith('l1', { note: null });
    expect(s.store.links().find((l) => l.id === 'l1')?.note).toBeNull();
    // This app says nothing when a note is saved.
    expect(s.store.toasts).toEqual([]);

    await expect(s.store.deleteLink('l1')).resolves.toBe(true);
    expect(s.api.deleteLink).toHaveBeenCalledWith('l1');
    expect(s.store.links().map((l) => l.id)).toEqual(['l2', 'l3']);
    expect(s.store.linksByNode().has('a2')).toBe(false);
    expect(s.store.droppedLinks).toEqual(['l1']);
    expect(s.store.toasts.at(-1)?.text).toBe('Link removed');
  });

  it('a failed removal keeps the link', async () => {
    const s = showing();
    s.api.deleteLink.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    await expect(s.store.deleteLink('l1')).resolves.toBe(false);
    expect(s.store.links()).toHaveLength(3);
    expect(s.store.droppedLinks).toEqual([]);
    expect(s.store.failures).toHaveLength(1);
  });

  it('a link already removed elsewhere (404) goes here too', async () => {
    const s = showing();
    s.api.updateLink.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Link not found'));
    await expect(s.store.updateLinkNote('l2', 'Why')).resolves.toBe(false);
    expect(s.store.links().map((l) => l.id)).toEqual(['l1', 'l3']);

    s.api.deleteLink.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Link not found'));
    await expect(s.store.deleteLink('l1')).resolves.toBe(true);
    expect(s.store.links().map((l) => l.id)).toEqual(['l3']);
    expect(s.store.droppedLinks).toEqual(['l2', 'l1']);
    expect(s.store.toasts).toEqual([
      { text: 'That link was already removed', kind: undefined },
      { text: 'That link was already removed', kind: undefined },
    ]);
    expect(s.store.failures).toEqual([]);
  });
});
