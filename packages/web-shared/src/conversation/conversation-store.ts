import { computed, signal } from '@angular/core';
import type { Router } from '@angular/router';
// The tree helpers only: the rest of @tangent/core (the ChatService) is for the lazy demo chunk.
import { indexLinks } from '@tangent/core/links';
import {
  branchChain,
  branchLeaf,
  branchPath,
  indexTree,
  navigate,
  type NavDirection,
  type TreeIndex,
} from '@tangent/core/tree';
import type {
  Branch,
  ChatNode,
  CommitCandidateResponse,
  CreateBranchRequest,
  CreateTreeRequest,
  DeleteBranchResponse,
  NodeLink,
  SendMessageRequest,
  StreamEvent,
  TreeDetail,
  TreeSummary,
  UpdateBranchRequest,
} from '@tangent/shared';
import { checkSourcesMessage } from '@tangent/shared';
import { ApiError, errorMessage, isNotFound, type ApiClient } from '../core/api-client';
import { coalesced } from '../core/coalesced';
import { runStream, type StreamOutcome } from '../sse/stream-runner';

/** Live state of a reply, kept apart from `detail` so deltas don't re-index the tree. */
export interface LiveReply {
  nodeId: string;
  treeId: string;
  branchId: string;
  content: string;
  /** Latest `status` event (e.g. "Summarizing parent context…"). */
  status: string | null;
  reconnecting: boolean;
}

/** The server calls the conversation engine makes. */
export type ConversationApi = Pick<
  ApiClient,
  | 'listTrees'
  | 'getTree'
  | 'createTree'
  | 'deleteTree'
  | 'createBranch'
  | 'updateBranch'
  | 'deleteBranch'
  | 'createLink'
  | 'updateLink'
  | 'deleteLink'
  | 'sendMessage'
  | 'streamNode'
  | 'cancelNode'
>;

/** How a message is asked: a "Check sources" request is web-searched (`ground`). */
export interface SendOptions {
  ground?: 'required';
}

/** A send that failed: what was asked, and whether its reply had started (it is in the tree then). */
export interface FailedSend {
  branchId: string;
  content: string;
  options: SendOptions;
  started: boolean;
}

/** The app's words for what the engine reports (its toasts, and the error of a tree that doesn't exist). */
export interface ConversationCopy {
  /** What a tree is called: "conversation", "lesson". */
  tree: string;
  /** What a branch is called: "branch", "lane", "side question". */
  branch: string;
  /** What a link between messages is called: "link", "connection". */
  link: string;
  /** Said when two messages are linked, and when they were already. */
  linked: { created: string; existing: string };
  /** Said when a link's note is saved, if anything. */
  noteSaved?: string;
}

function capitalized(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function summaryOf(d: TreeDetail): TreeSummary {
  return {
    id: d.tree.id,
    title: d.tree.title,
    createdAt: d.tree.createdAt,
    updatedAt: d.tree.updatedAt,
    branchCount: d.branches.length,
    messageCount: d.nodes.length,
  };
}

function upsertById<T extends { id: string }>(list: readonly T[], items: readonly T[]): T[] {
  const out = [...list];
  for (const item of items) {
    const i = out.findIndex((x) => x.id === item.id);
    if (i === -1) out.push(item);
    else out[i] = item;
  }
  return out;
}

/**
 * The conversation engine the apps' stores are built on (power's TreeStore,
 * the canvas's CanvasStore, Learn's LessonStore): the tree list, the open
 * tree and the selected branch (the URL is the source of truth for both),
 * and every live reply. Any number of branches may generate at once (the
 * server only refuses a send into a branch whose leaf is still streaming),
 * and `live` holds them all. Plain signals and no DI, so it can be unit
 * tested; each app extends it with its own state, and its side effects
 * (toasts, dialogs) go through the hooks it implements.
 */
export abstract class ConversationStore<A extends ConversationApi = ConversationApi> {
  readonly trees = signal<TreeSummary[]>([]);
  readonly treesLoaded = signal(false);

  readonly selectedTreeId = signal<string | null>(null);
  readonly detail = signal<TreeDetail | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);
  private readonly routeBranchId = signal<string | null>(null);
  /** The message the URL points at (`?m=`), e.g. the branch point after going back to the parent. */
  readonly focusedNodeId = signal<string | null>(null);

  readonly live = signal<ReadonlyMap<string, LiveReply>>(new Map());
  /** Branches whose POST is in flight (before `start` arrives). */
  readonly sending = signal<ReadonlySet<string>>(new Set());
  /** Bumped whenever a reply finishes. */
  readonly completions = signal(0);
  protected readonly controllers = new Map<string, AbortController>();
  private detailSeq = 0;
  private treesSeq = 0;

  readonly index = computed<TreeIndex | null>(() => {
    const d = this.detail();
    if (!d) return null;
    try {
      return indexTree(d.branches, d.nodes);
    } catch (err) {
      console.error('indexTree failed', err);
      return null;
    }
  });

  /** The tree's links between messages, oldest first. */
  readonly links = computed<readonly NodeLink[]>(() => this.detail()?.links ?? []);

  /** Links by node id, each link under both of its ends. */
  readonly linksByNode = computed<ReadonlyMap<string, readonly NodeLink[]>>(() =>
    indexLinks(this.links()),
  );

  /** The branch in the URL while the tree has it, else the trunk. */
  readonly selectedBranchId = computed<string | null>(() => {
    const idx = this.index();
    if (!idx) return null;
    const id = this.routeBranchId();
    return id && idx.branches.has(id) ? id : idx.trunk.id;
  });

  readonly selectedBranch = computed<Branch | null>(() => {
    const idx = this.index();
    const id = this.selectedBranchId();
    return (idx && id && idx.branches.get(id)) || null;
  });

  readonly parentBranch = computed<Branch | null>(() => {
    const b = this.selectedBranch();
    const idx = this.index();
    return (b?.parentBranchId && idx?.branches.get(b.parentBranchId)) || null;
  });

  /** Trunk → selected branch. */
  readonly chain = computed<Branch[]>(() => {
    const idx = this.index();
    const id = this.selectedBranchId();
    return idx && id ? branchChain(idx, id) : [];
  });

  /** Root → leaf of the selected branch (ancestor branches' messages first). */
  readonly path = computed<ChatNode[]>(() => {
    const idx = this.index();
    const id = this.selectedBranchId();
    return idx && id ? branchPath(idx, id) : [];
  });

  /** The selected branch's last message (null while it has none of its own). */
  readonly leaf = computed<ChatNode | null>(() => {
    const idx = this.index();
    const id = this.selectedBranchId();
    return idx && id ? branchLeaf(idx, id) : null;
  });

  /** The reply generating in the selected branch. */
  readonly streamingNode = computed<ChatNode | null>(() => {
    const id = this.selectedBranchId();
    return id ? this.streamingIn(id) : null;
  });

  /** The selected branch can't take a message: its reply is generating, or its send is in flight. */
  readonly busy = computed(() => {
    const id = this.selectedBranchId();
    return this.streamingNode() !== null || (id !== null && this.sending().has(id));
  });

  constructor(
    protected readonly api: A,
    protected readonly router: Pick<Router, 'navigate'>,
    private readonly copy: ConversationCopy,
  ) {}

  /** The app's error policy: every failed call ends here. */
  abstract fail(err: unknown): void;

  /** A toast. */
  protected abstract notify(text: string, kind?: 'info' | 'error'): void;

  /** The open tree changed (another one, none, or a new one): state about the old one goes. */
  protected treeChanged(): void {}

  /** What else to refresh after a reply, alongside the tree list (e.g. the balance). */
  protected alsoRefreshAfterReply(): Promise<unknown> | null {
    return null;
  }

  /** What the app adds to every message it sends (e.g. power's reply length). */
  protected sendExtras(): Partial<SendMessageRequest> {
    return {};
  }

  /** A send into `branchId` starts: what waited for that branch to send again goes. */
  protected sendStarting(_branchId: string, _options: SendOptions): void {}

  /** The message is in the tree now: the composer may let its text go. */
  protected sent(_branchId: string, _content: string): void {}

  /** A send failed; by default the app's error policy reports it. */
  protected sendFailed(err: unknown, _send: FailedSend): void {
    this.fail(err);
  }

  /** Tree `treeId` was deleted: what the app keeps about it goes. */
  protected treeDeleted(_treeId: string): void {}

  /** Branches and their messages were deleted: what the app keeps about them goes. */
  protected branchesRemoved(_branchIds: ReadonlySet<string>, _nodeIds: ReadonlySet<string>): void {}

  /** A link went from the open tree. */
  protected linkDropped(_linkId: string): void {}

  /** The route a branch made here starts on, after `from` (none: the server picks the parent's). */
  protected newBranchRoute(_from: Branch | null): Partial<CreateBranchRequest> {
    return {};
  }

  // The tree list

  async loadTrees(): Promise<void> {
    try {
      await this.readTrees();
    } catch (err) {
      this.fail(err);
    } finally {
      this.treesLoaded.set(true);
    }
  }

  /** Reads the list; a read answering after one started later is dropped. */
  private async readTrees(): Promise<void> {
    const seq = ++this.treesSeq;
    const list = await this.api.listTrees();
    if (seq === this.treesSeq) this.trees.set(list);
  }

  /** A change made here (created, deleted, renamed): a read sent before it would undo it. */
  protected editTrees(change: (list: TreeSummary[]) => TreeSummary[]): void {
    this.treesSeq++;
    this.trees.update(change);
  }

  /** A tree made here (new, imported) goes first in the list. */
  protected listNewTree(detail: TreeDetail): void {
    this.editTrees((list) => [summaryOf(detail), ...list]);
  }

  // Routing (the URL is the source of truth for the selection)

  /** Called by the routed page whenever the URL changes. */
  setRoute(treeId: string | null, branchId: string | null, focusNodeId: string | null): void {
    this.routeBranchId.set(branchId);
    this.focusedNodeId.set(focusNodeId);
    if (treeId !== this.selectedTreeId()) {
      this.selectedTreeId.set(treeId);
      this.treeChanged();
      if (treeId) void this.loadTree(treeId);
      else this.showDetail(null);
    }
  }

  go(branchId: string, focusNodeId: string | null = null, replace = false): void {
    const treeId = this.selectedTreeId();
    if (!treeId) return;
    const idx = this.index();
    const commands =
      idx && branchId === idx.trunk.id && !focusNodeId
        ? ['/t', treeId]
        : ['/t', treeId, 'b', branchId];
    void this.router.navigate(commands, {
      queryParams: focusNodeId ? { m: focusNodeId } : {},
      replaceUrl: replace,
    });
  }

  focus(nodeId: string | null): void {
    const branchId = this.selectedBranchId();
    if (branchId) this.go(branchId, nodeId, true);
  }

  /** Keyboard branch navigation (Alt+arrows, [ and ]). */
  navigate(direction: NavDirection): boolean {
    const idx = this.index();
    const id = this.selectedBranchId();
    if (!idx || !id) return false;
    const target = navigate(idx, id, direction);
    if (!target) return false;
    this.go(target.branchId, target.focusNodeId);
    return true;
  }

  /** The branch message `nodeId` is in, or null when the open tree hasn't it. */
  branchOf(nodeId: string): Branch | null {
    const idx = this.index();
    const node = idx?.nodes.get(nodeId);
    return (node && idx?.branches.get(node.branchId)) || null;
  }

  /** `nodeId` is the newest message of the open branch (where "Continue" and an open "Ask" go). */
  isLatest(nodeId: string): boolean {
    return (
      this.branchOf(nodeId)?.id === this.selectedBranchId() && this.path().at(-1)?.id === nodeId
    );
  }

  childBranchesAt(nodeId: string): readonly Branch[] {
    return this.index()?.branchesAtNode.get(nodeId) ?? [];
  }

  /** Depth of a branch: 0 for the main thread, 1 for a branch of it, … */
  depthOf(branchId: string): number {
    const idx = this.index();
    return idx ? Math.max(0, branchChain(idx, branchId).length - 1) : 0;
  }

  // The open tree

  async loadTree(treeId: string, force = false): Promise<void> {
    if (!force && this.detail()?.tree.id === treeId) return;
    const seq = ++this.detailSeq;
    this.detailLoading.set(true);
    this.detailError.set(null);
    if (this.detail()?.tree.id !== treeId) this.detail.set(null);
    try {
      const detail = await this.api.getTree(treeId);
      if (!this.loadCurrent(seq, treeId)) return;
      this.detail.set(detail);
      this.resumeStreaming(detail.nodes);
    } catch (err) {
      if (!this.loadCurrent(seq, treeId)) return;
      this.detailError.set(
        err instanceof ApiError && err.status === 404
          ? `This ${this.copy.tree} does not exist.`
          : errorMessage(err),
      );
    } finally {
      if (seq === this.detailSeq) this.detailLoading.set(false);
    }
  }

  /** The load numbered `seq` of `treeId` is still the one wanted (no other tree, nor none, since). */
  private loadCurrent(seq: number, treeId: string): boolean {
    return seq === this.detailSeq && this.selectedTreeId() === treeId;
  }

  /** Shows `detail` (null: no tree), dropping whatever tree load is still in flight. */
  private showDetail(detail: TreeDetail | null): void {
    this.detailSeq++;
    this.detailLoading.set(false);
    this.detailError.set(null);
    this.detail.set(detail);
  }

  /** Creates a tree and opens it, first in the list. Throws what the server refused. */
  protected async openNewTree(req: CreateTreeRequest): Promise<TreeDetail> {
    const detail = await this.api.createTree(req);
    this.showDetail(detail);
    this.selectedTreeId.set(detail.tree.id);
    this.treeChanged();
    this.listNewTree(detail);
    await this.router.navigate(['/t', detail.tree.id]);
    return detail;
  }

  /**
   * Deletes a whole tree (not a generating call: it stays available while
   * power is read-only), and stops following its replies. If it is open,
   * goes home. The caller confirms first. Resolves true if it was deleted.
   */
  async deleteTree(treeId: string): Promise<boolean> {
    try {
      await this.api.deleteTree(treeId);
      this.stopTreeStreams(treeId);
      this.treeDeleted(treeId);
      this.editTrees((list) => list.filter((t) => t.id !== treeId));
      if (this.selectedTreeId() === treeId) await this.router.navigate(['/']);
      this.notify(`${capitalized(this.copy.tree)} deleted`);
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  // Branches

  /** Creates a branch into the open tree (null if it could not be created). */
  protected async addBranch(req: CreateBranchRequest): Promise<Branch | null> {
    try {
      const branch = await this.api.createBranch(req);
      this.applyBranch(branch);
      return branch;
    } catch (err) {
      this.fail(err);
      return null;
    }
  }

  /**
   * Creates a branch, opens it and sends `content` as its first message.
   * Resolves once the branch exists (null if it could not be created: the
   * caller keeps the text); the reply streams on.
   */
  async startBranch(req: CreateBranchRequest, content: string): Promise<Branch | null> {
    const branch = await this.addBranch(req);
    if (branch) {
      this.go(branch.id);
      void this.send(branch.id, content);
    }
    return branch;
  }

  async updateBranch(branchId: string, req: UpdateBranchRequest): Promise<boolean> {
    try {
      this.applyBranch(await this.api.updateBranch(branchId, req));
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /**
   * Deletes a branch with everything below it; replies generating there stop.
   * If the selection is inside it, moves to the message it branched from.
   * The caller confirms first.
   */
  async deleteBranch(branchId: string): Promise<boolean> {
    const doomed = this.index()?.branches.get(branchId);
    try {
      const res = await this.api.deleteBranch(branchId);
      const selected = this.selectedBranchId();
      if (doomed?.parentBranchId && selected && res.branchIds.includes(selected)) {
        this.go(doomed.parentBranchId, doomed.branchPointNodeId, true);
      }
      this.removeBranches(res);
      const below = res.branchIds.length - 1;
      this.notify(
        below > 0
          ? `Deleted the ${this.copy.branch} and ${below} below it`
          : `${capitalized(this.copy.branch)} deleted`,
      );
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  private removeBranches(res: DeleteBranchResponse): void {
    const branchIds = new Set(res.branchIds);
    const nodeIds = new Set(res.nodeIds);
    // Their generations were stopped server-side; stop following them here too.
    for (const id of nodeIds) this.stopFollowing(id);
    this.detail.update((d) =>
      d && d.tree.id === res.treeId
        ? {
            ...d,
            branches: d.branches.filter((b) => !branchIds.has(b.id)),
            nodes: d.nodes.filter((n) => !nodeIds.has(n.id)),
            // The server dropped the links touching them with them.
            links: d.links.filter(
              (l) => !nodeIds.has(l.sourceNodeId) && !nodeIds.has(l.targetNodeId),
            ),
          }
        : d,
    );
    this.branchesRemoved(branchIds, nodeIds);
    const d = this.detail();
    if (d && d.tree.id === res.treeId) {
      this.editTrees((list) =>
        list.map((t) =>
          t.id === res.treeId
            ? { ...t, branchCount: d.branches.length, messageCount: d.nodes.length }
            : t,
        ),
      );
    }
  }

  /**
   * "Check sources" on a finished reply: a web-searched check of it. After
   * the open branch's last reply it is appended there; on an earlier reply,
   * including one of an ancestor branch (the open branch's messages follow
   * it on screen), it opens a `path` branch, so later messages keep their
   * place and the check streams where the user sees it.
   */
  async checkSources(nodeId: string): Promise<boolean> {
    const idx = this.index();
    const node = idx?.nodes.get(nodeId);
    if (!idx || !node || node.role !== 'assistant') return false;
    const parent = node.parentId ? idx.nodes.get(node.parentId) : undefined;
    const content = checkSourcesMessage(parent?.role === 'user' ? parent.content : null);
    if (node.branchId === this.selectedBranchId() && this.leaf()?.id === node.id) {
      return this.send(node.branchId, content, { ground: 'required' });
    }
    const branch = await this.addBranch({
      fromNodeId: node.id,
      contextMode: 'path',
      anchorQuote: null,
      title: 'Checking sources',
      ...this.newBranchRoute(idx.branches.get(node.branchId) ?? null),
    });
    if (!branch) return false;
    this.go(branch.id);
    return this.send(branch.id, content, { ground: 'required' });
  }

  // Links between messages

  /**
   * Links two messages of the open tree (not a generating call: it stays
   * available while power is read-only). Two messages already linked, either
   * way round, keep their link.
   */
  async createLink(
    fromNodeId: string,
    toNodeId: string,
    note: string | null = null,
  ): Promise<NodeLink | null> {
    try {
      // The server says whether the pair was linked already (perhaps in another tab).
      const { link, created } = await this.api.createLink({ fromNodeId, toNodeId, note });
      this.applyLinks([link]);
      this.notify(created ? this.copy.linked.created : this.copy.linked.existing);
      return link;
    } catch (err) {
      this.fail(err);
      return null;
    }
  }

  /** The note on a link; null clears it. */
  async updateLinkNote(linkId: string, note: string | null): Promise<boolean> {
    try {
      this.applyLinks([await this.api.updateLink(linkId, { note })]);
      if (this.copy.noteSaved) this.notify(this.copy.noteSaved);
      return true;
    } catch (err) {
      if (isNotFound(err)) this.dropGoneLink(linkId);
      else this.fail(err);
      return false;
    }
  }

  /** Removes a link from both of its messages. The caller confirms first. */
  async deleteLink(linkId: string): Promise<boolean> {
    try {
      await this.api.deleteLink(linkId);
      this.dropLink(linkId);
      this.notify(`${capitalized(this.copy.link)} removed`);
      return true;
    } catch (err) {
      // Removed elsewhere already (another tab, or another app): the same outcome.
      if (isNotFound(err)) {
        this.dropGoneLink(linkId);
        return true;
      }
      this.fail(err);
      return false;
    }
  }

  private dropLink(linkId: string): void {
    this.detail.update((d) => (d ? { ...d, links: d.links.filter((l) => l.id !== linkId) } : d));
    this.linkDropped(linkId);
  }

  /** A link the server no longer has (removed elsewhere): it goes here too. */
  private dropGoneLink(linkId: string): void {
    this.dropLink(linkId);
    this.notify(`That ${this.copy.link} was already removed`);
  }

  // Replies

  /**
   * Sends `content` into `branchId` and follows the reply until it ends,
   * reconnecting when the stream drops. Resolves false when the send failed
   * (`sendFailed` has had it).
   */
  async send(branchId: string, content: string, options: SendOptions = {}): Promise<boolean> {
    this.markSending(branchId, true);
    this.sendStarting(branchId, options);
    const ctrl = new AbortController();
    let nodeId: string | null = null;
    try {
      const outcome = await runStream(
        {
          open: (signal) =>
            this.api.sendMessage(branchId, { content, ...options, ...this.sendExtras() }, signal),
          reconnect: (id, signal) => this.api.streamNode(id, signal),
        },
        (event) => {
          if (event.type === 'start') {
            nodeId = event.assistantNode.id;
            this.controllers.set(nodeId, ctrl);
            this.markSending(branchId, false);
            this.sent(branchId, content);
          }
          this.apply(event, nodeId);
        },
        {
          signal: ctrl.signal,
          onReconnect: () => nodeId && this.patchLive(nodeId, { reconnecting: true }),
        },
      );
      this.finish(nodeId, outcome);
      return true;
    } catch (err) {
      this.sendFailed(err, { branchId, content, options, started: nodeId !== null });
      return false;
    } finally {
      this.markSending(branchId, false);
      if (nodeId) this.controllers.delete(nodeId);
    }
  }

  /** Stop: the server cancels the generation and the stream ends with an `error` event. */
  async cancel(nodeId: string): Promise<void> {
    try {
      await this.api.cancelNode(nodeId);
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * A Compare pick the server committed (`POST …/candidates/:id/commit`): the
   * question and the kept answer join the tree as a finished send's `start`
   * and `done` would add them, and the same refresh follows (auto-titling).
   */
  applyCommitted(result: CommitCandidateResponse): void {
    const { userNode, assistantNode, branch } = result;
    this.apply({ type: 'start', userNode, assistantNode, branch }, null);
    this.apply({ type: 'done', node: assistantNode, branch }, assistantNode.id);
    this.finish(assistantNode.id, { kind: 'done' });
  }

  /** The reply generating in `branchId`, if any. */
  streamingIn(branchId: string): ChatNode | null {
    const idx = this.index();
    if (!idx) return null;
    return (idx.nodesByBranch.get(branchId) ?? []).find((n) => n.status === 'streaming') ?? null;
  }

  private markSending(branchId: string, on: boolean): void {
    if (this.sending().has(branchId) === on) return;
    this.sending.update((set) => {
      const next = new Set(set);
      if (on) next.add(branchId);
      else next.delete(branchId);
      return next;
    });
  }

  /** A reply's stream ended (`nodeId` null: it never started). */
  protected finish(nodeId: string | null, outcome: StreamOutcome): void {
    if (outcome.kind === 'lost') {
      this.notify(
        `Lost the connection to the reply: ${outcome.message}. Reload to check on it.`,
        'error',
      );
      if (nodeId) {
        // Unblock the composer; the server answers a racing send with 409 if it is still generating.
        this.markError(nodeId, 'Connection lost. Reload to see the final reply.');
        this.dropLive(nodeId);
      }
    }
    this.completions.update((n) => n + 1);
    void this.refreshAfterCompletion();
  }

  /**
   * Titles can change after the first reply (auto-titling): refresh the list
   * and the tree title, with whatever else the app refreshes then. Replies
   * finishing together (a fan-out) share one refresh, plus one more if asked
   * meanwhile. Quiet on failure: the next reply refreshes again.
   */
  private readonly refreshAfterCompletion = coalesced(async () => {
    const listed = this.readTrees().then(
      () => true,
      (err: unknown) => {
        console.warn('tree list refresh failed', err);
        return false;
      },
    );
    const [ok] = await Promise.all([listed, this.alsoRefreshAfterReply()]);
    if (!ok) return;
    const d = this.detail();
    const summary = d && this.trees().find((t) => t.id === d.tree.id);
    if (d && summary && summary.title !== d.tree.title) {
      this.detail.update((cur) =>
        cur ? { ...cur, tree: { ...cur.tree, title: summary.title } } : cur,
      );
    }
  });

  /** After loading a tree: re-attach to replies still generating server-side. */
  protected resumeStreaming(nodes: readonly ChatNode[]): void {
    for (const n of nodes) {
      if (n.status !== 'streaming' || n.role !== 'assistant' || this.controllers.has(n.id))
        continue;
      const ctrl = new AbortController();
      this.controllers.set(n.id, ctrl);
      this.setLive({
        nodeId: n.id,
        treeId: n.treeId,
        branchId: n.branchId,
        content: n.content,
        status: null,
        reconnecting: false,
      });
      void runStream(
        { open: null, reconnect: (id, signal) => this.api.streamNode(id, signal) },
        (event) => this.apply(event, n.id),
        { nodeId: n.id, signal: ctrl.signal, baseDelayMs: 1000 },
      )
        .then((outcome) => this.finish(n.id, outcome))
        .finally(() => this.controllers.delete(n.id));
    }
  }

  /** One stream event into the tree and `live`; `streamNodeId` is the reply it is about, once known. */
  protected apply(event: StreamEvent, streamNodeId: string | null): void {
    switch (event.type) {
      case 'start':
        this.applyNodes([event.userNode, event.assistantNode]);
        this.applyBranch(event.branch);
        this.setLive({
          nodeId: event.assistantNode.id,
          treeId: event.assistantNode.treeId,
          branchId: event.assistantNode.branchId,
          content: event.assistantNode.content,
          status: null,
          reconnecting: false,
        });
        break;
      case 'snapshot':
        this.patchLive(event.node.id, { content: event.node.content, reconnecting: false });
        if (event.node.status !== 'streaming') this.applyNodes([event.node]);
        break;
      case 'status':
        if (streamNodeId) this.patchLive(streamNodeId, { status: event.message });
        break;
      case 'delta': {
        const s = this.live().get(event.nodeId);
        if (s)
          this.patchLive(event.nodeId, {
            content: s.content + event.text,
            status: null,
            reconnecting: false,
          });
        break;
      }
      case 'usage':
        break;
      case 'done':
        this.applyNodes([event.node]);
        this.applyBranch(event.branch);
        this.dropLive(event.node.id);
        break;
      case 'error':
        if (event.node) this.applyNodes([event.node]);
        else if (event.nodeId) this.markError(event.nodeId, event.message);
        if (event.nodeId) this.dropLive(event.nodeId);
        break;
    }
  }

  /** Marks a reply failed, keeping the text it streamed. */
  protected markError(nodeId: string, message: string): void {
    const node = this.index()?.nodes.get(nodeId);
    if (node)
      this.applyNodes([
        {
          ...node,
          status: 'error',
          error: message,
          content: this.live().get(nodeId)?.content ?? node.content,
        },
      ]);
  }

  /** Nodes into the open tree (those of another tree, opened meanwhile, are dropped). */
  protected applyNodes(nodes: ChatNode[]): void {
    this.detail.update((d) => {
      if (!d) return d;
      const mine = nodes.filter((n) => n.treeId === d.tree.id);
      return mine.length ? { ...d, nodes: upsertById(d.nodes, mine) } : d;
    });
  }

  protected applyBranch(branch: Branch): void {
    this.detail.update((d) =>
      d && d.tree.id === branch.treeId ? { ...d, branches: upsertById(d.branches, [branch]) } : d,
    );
  }

  protected applyLinks(links: NodeLink[]): void {
    this.detail.update((d) => {
      if (!d) return d;
      const mine = links.filter((l) => l.treeId === d.tree.id);
      return mine.length ? { ...d, links: upsertById(d.links, mine) } : d;
    });
  }

  /** Stops following the replies of a deleted tree (the server has no tree to stream them from). */
  protected stopTreeStreams(treeId: string): void {
    for (const l of this.live().values()) {
      if (l.treeId !== treeId) continue;
      this.stopFollowing(l.nodeId);
    }
  }

  /** Stops following one reply (its tree or branch is gone). */
  protected stopFollowing(nodeId: string): void {
    this.controllers.get(nodeId)?.abort();
    this.controllers.delete(nodeId);
    this.dropLive(nodeId);
  }

  protected setLive(s: LiveReply): void {
    this.live.update((m) => new Map(m).set(s.nodeId, s));
  }

  protected patchLive(nodeId: string, patch: Partial<LiveReply>): void {
    const cur = this.live().get(nodeId);
    if (cur) this.setLive({ ...cur, ...patch });
  }

  protected dropLive(nodeId: string): void {
    if (!this.live().has(nodeId)) return;
    this.live.update((m) => {
      const next = new Map(m);
      next.delete(nodeId);
      return next;
    });
  }
}
