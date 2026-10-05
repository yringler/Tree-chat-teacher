import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  branchChain,
  branchLeaf,
  branchPath,
  descendantBranches,
  indexTree,
  navigate,
  type NavDirection,
  type TreeIndex,
} from '@tangent/core/tree';
import type {
  BillingSummary,
  Branch,
  ChatNode,
  ContextMode,
  ContextPlan,
  CreateBranchRequest,
  DeleteBranchResponse,
  KeyStatusResponse,
  MeResponse,
  MembershipInfo,
  ProviderInfo,
  StreamEvent,
  TreeDetail,
  TreeSummary,
  UpdateBranchRequest,
} from '@tangent/shared';
import {
  ApiClient,
  ApiError,
  errorMessage,
  membershipBlocks,
  runStream,
  type StreamOutcome,
} from '@tangent/web-shared';
import { UiStore } from './ui-store';

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

/** One branch to create in a fan-out: the same message asked N ways. */
export interface BranchVariant {
  contextMode: ContextMode;
  providerId: string;
  model: string;
}

export interface FanOutRequest {
  fromNodeId: string;
  anchorQuote: string | null;
  /** Optional shared title; variants get the model and mode appended when there are several. */
  title: string;
  isPrivate: boolean;
  variants: BranchVariant[];
  /** Sent to every new branch at once; empty = just create the branches. */
  firstMessage: string;
}

/**
 * What the model would see for one lane, as the context planner computes it
 * (`GET /api/branches/:id/context`, summaries not resolved). The canvas lights
 * the source messages and marks compacted or dropped ones.
 */
export interface Lineage {
  branchId: string;
  /** The leaf the plan replies to (null for an empty branch); part of the cache key. */
  leafId: string | null;
  plan: ContextPlan;
  /** Messages whose text is in the prompt as is. */
  verbatim: ReadonlySet<string>;
  /** Messages present only through a summary (branch summary or budget compaction). */
  summarized: ReadonlySet<string>;
  /** Messages dropped because even compaction could not fit the budget. */
  dropped: ReadonlySet<string>;
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

/** Short label of a model id: the part after the last `/` (OpenRouter ids), trimmed. */
export function modelLabel(providers: readonly ProviderInfo[], providerId: string, model: string) {
  const p = providers.find((x) => x.id === providerId);
  const m = p?.models.find((x) => x.id === model);
  if (m) return m.label;
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/**
 * Canvas state: the conversation list, the open tree, the selected lane and
 * every live reply. Unlike the other apps, nothing here is "the" stream:
 * any number of lanes may generate at once (the server only refuses a send
 * into a branch whose leaf is still streaming), and `live` holds them all.
 */
@Injectable({ providedIn: 'root' })
export class CanvasStore {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly ui = inject(UiStore);

  // Global data
  readonly me = signal<MeResponse | null>(null);
  readonly providers = signal<ProviderInfo[]>([]);
  readonly keyStatus = signal<KeyStatusResponse | null>(null);
  /** From `me`; a 402 `membership_required` marks it inactive. */
  readonly membership = signal<MembershipInfo | null>(null);
  /** Credit balance and fees (`/api/billing`), loaded when the keys dialog opens. */
  readonly billing = signal<BillingSummary | null>(null);
  readonly trees = signal<TreeSummary[]>([]);
  readonly treesLoaded = signal(false);

  // The open tree
  readonly selectedTreeId = signal<string | null>(null);
  readonly detail = signal<TreeDetail | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);
  private readonly routeBranchId = signal<string | null>(null);
  readonly focusedNodeId = signal<string | null>(null);

  // Replies
  readonly live = signal<ReadonlyMap<string, LiveReply>>(new Map());
  /** Branches whose POST is in flight (before `start` arrives). */
  readonly sending = signal<ReadonlySet<string>>(new Set());
  /** Bumped whenever a generation finishes; the lineage refreshes on it. */
  readonly completions = signal(0);
  private readonly controllers = new Map<string, AbortController>();
  private detailSeq = 0;

  // Lineage (one plan per lane, cached by leaf)
  readonly lineages = signal<ReadonlyMap<string, Lineage>>(new Map());
  readonly lineageLoading = signal<string | null>(null);
  private lineageSeq = 0;
  /** `branch|leaf` keys with a request running, so a re-run effect doesn't send another. */
  private readonly lineageInFlight = new Set<string>();
  /** `branch|leaf` keys whose request failed: not retried until the tree or the lane changes. */
  private readonly lineageFailed = new Set<string>();

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

  /** Trunk → selected lane. */
  readonly chain = computed<Branch[]>(() => {
    const idx = this.index();
    const id = this.selectedBranchId();
    return idx && id ? branchChain(idx, id) : [];
  });

  readonly chainIds = computed<ReadonlySet<string>>(() => new Set(this.chain().map((b) => b.id)));

  /** Root → leaf of the selected lane. */
  readonly path = computed<ChatNode[]>(() => {
    const idx = this.index();
    const id = this.selectedBranchId();
    return idx && id ? branchPath(idx, id) : [];
  });

  /** Generating (power mode) needs the membership the user lacks: the shell shows a notice linking to `/billing`. */
  readonly membershipBlocked = computed(() => membershipBlocks(this.membership()));

  readonly providerMap = computed(() => new Map(this.providers().map((p) => [p.id, p])));

  /** First provider with an API key, falling back to the first configured. */
  readonly defaultProvider = computed<ProviderInfo | null>(
    () => this.providers().find((p) => p.available) ?? this.providers()[0] ?? null,
  );

  /** The lineage of the selected lane, when it is for its current leaf. */
  readonly selectedLineage = computed<Lineage | null>(() => {
    const id = this.selectedBranchId();
    const idx = this.index();
    if (!id || !idx) return null;
    const l = this.lineages().get(id);
    const leaf = branchLeaf(idx, id)?.id ?? null;
    return l && l.leafId === leaf ? l : null;
  });

  /** Branch ids whose leaf the tree has as streaming (re-read only when the tree changes). */
  private readonly streamingBranches = computed<ReadonlySet<string>>(() => {
    const set = new Set<string>();
    const idx = this.index();
    if (idx) {
      for (const n of idx.nodes.values()) if (n.status === 'streaming') set.add(n.branchId);
    }
    return set;
  });

  /**
   * Branch ids with a reply generating or a send in flight. Every delta
   * replaces `live`, so the set is compared by content: readers are only
   * notified when a lane starts or stops being busy, not once per frame.
   */
  readonly busyBranches = computed<ReadonlySet<string>>(
    () => {
      const set = new Set(this.sending());
      for (const l of this.live().values()) set.add(l.branchId);
      for (const id of this.streamingBranches()) set.add(id);
      return set;
    },
    { equal: (a, b) => a.size === b.size && [...a].every((x) => b.has(x)) },
  );

  // Bootstrapping

  async init(me: MeResponse): Promise<void> {
    this.me.set(me);
    this.membership.set(me.membership);
    await Promise.all([this.refreshKeys(), this.loadTrees()]);
  }

  async refreshKeys(): Promise<void> {
    await Promise.all([
      this.api.keyStatus().then(
        (s) => this.keyStatus.set(s),
        (e: unknown) => this.fail(e),
      ),
      this.api.providers().then(
        (p) => this.providers.set(p),
        (e: unknown) => this.fail(e),
      ),
    ]);
  }

  /** Credit balance and fees. Quiet on failure: the keys dialog then shows no balance. */
  async refreshBilling(): Promise<void> {
    try {
      this.billing.set(await this.api.billing());
    } catch (err) {
      console.warn('billing summary failed', err);
    }
  }

  async saveKey(provider: string, apiKey: string): Promise<boolean> {
    try {
      await this.api.saveKey(provider, apiKey);
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    } finally {
      await this.refreshKeys();
    }
  }

  async forgetKey(provider?: string): Promise<void> {
    try {
      await this.api.forgetKey(provider);
    } catch (err) {
      this.fail(err);
    } finally {
      await this.refreshKeys();
    }
  }

  async loadTrees(): Promise<void> {
    try {
      this.trees.set(await this.api.listTrees());
    } catch (err) {
      this.fail(err);
    } finally {
      this.treesLoaded.set(true);
    }
  }

  // Routing (the URL is the source of truth for the selection)

  setRoute(treeId: string | null, branchId: string | null, focusNodeId: string | null): void {
    this.routeBranchId.set(branchId);
    this.focusedNodeId.set(focusNodeId);
    if (treeId !== this.selectedTreeId()) {
      this.selectedTreeId.set(treeId);
      this.lineages.set(new Map());
      this.lineageFailed.clear();
      if (treeId) void this.loadTree(treeId);
      else {
        this.detail.set(null);
        this.detailError.set(null);
      }
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

  /** Keyboard lane navigation (Alt+arrows, [ and ]). */
  navigate(direction: NavDirection): boolean {
    const idx = this.index();
    const id = this.selectedBranchId();
    if (!idx || !id) return false;
    const target = navigate(idx, id, direction);
    if (!target) return false;
    this.go(target.branchId, target.focusNodeId);
    return true;
  }

  childBranchesAt(nodeId: string): readonly Branch[] {
    return this.index()?.branchesAtNode.get(nodeId) ?? [];
  }

  /** Branches strictly below `branchId` (what a collapsed lane hides). */
  descendants(branchId: string): Branch[] {
    const idx = this.index();
    return idx ? descendantBranches(idx, branchId) : [];
  }

  // Trees

  async loadTree(treeId: string, force = false): Promise<void> {
    if (!force && this.detail()?.tree.id === treeId) return;
    const seq = ++this.detailSeq;
    this.detailLoading.set(true);
    this.detailError.set(null);
    if (this.detail()?.tree.id !== treeId) this.detail.set(null);
    try {
      const detail = await this.api.getTree(treeId);
      if (seq !== this.detailSeq) return;
      this.detail.set(detail);
      this.resumeStreaming(detail.nodes);
    } catch (err) {
      if (seq !== this.detailSeq) return;
      this.detailError.set(
        err instanceof ApiError && err.status === 404
          ? 'This conversation does not exist.'
          : errorMessage(err),
      );
    } finally {
      if (seq === this.detailSeq) this.detailLoading.set(false);
    }
  }

  /** New tree from the home page: creates it, opens it, sends the first message. */
  async startConversation(
    content: string,
    providerId: string | null,
    model: string | null,
  ): Promise<void> {
    try {
      const detail = await this.api.createTree({
        ...(providerId ? { providerId } : {}),
        ...(model ? { model } : {}),
      });
      this.detail.set(detail);
      this.selectedTreeId.set(detail.tree.id);
      this.trees.update((list) => [summaryOf(detail), ...list]);
      await this.router.navigate(['/t', detail.tree.id]);
      void this.send(detail.tree.trunkBranchId, content);
    } catch (err) {
      this.fail(err);
    }
  }

  async deleteTree(treeId: string): Promise<void> {
    try {
      await this.api.deleteTree(treeId);
      this.trees.update((list) => list.filter((t) => t.id !== treeId));
      if (this.selectedTreeId() === treeId) await this.router.navigate(['/']);
      this.ui.notify('Conversation deleted');
    } catch (err) {
      this.fail(err);
    }
  }

  // Branches

  async createBranch(req: CreateBranchRequest, open = true): Promise<Branch | null> {
    try {
      const branch = await this.api.createBranch(req);
      this.applyBranch(branch);
      if (open) {
        this.go(branch.id);
        this.ui.focusComposer();
      }
      return branch;
    } catch (err) {
      this.fail(err);
      return null;
    }
  }

  /**
   * The canvas's signature move: one message, asked several ways at once.
   * Every variant becomes a sibling lane off the same message (its own
   * context mode and model), and the first message, when given, is sent to
   * all of them in parallel. Resolves with the lanes that were created.
   */
  async fanOut(req: FanOutRequest): Promise<Branch[]> {
    const several = req.variants.length > 1;
    const created: Branch[] = [];
    const base = req.title.trim();
    for (const v of req.variants) {
      const suffix = `${modelLabel(this.providers(), v.providerId, v.model)} · ${v.contextMode}`;
      const title = several ? (base ? `${base} (${suffix})` : suffix) : base;
      const branch = await this.createBranch(
        {
          fromNodeId: req.fromNodeId,
          contextMode: v.contextMode,
          anchorQuote: req.anchorQuote,
          providerId: v.providerId,
          model: v.model,
          isPrivate: req.isPrivate,
          ...(title ? { title } : {}),
        },
        false,
      );
      if (branch) created.push(branch);
    }
    const first = created[0];
    if (!first) return created;
    this.go(first.id);
    const message = req.firstMessage.trim();
    if (message) {
      for (const b of created) void this.send(b.id, message);
    } else {
      this.ui.focusComposer();
    }
    return created;
  }

  /**
   * Follows a tangent the assistant suggested under `fromNodeId`: a `path`
   * branch titled after it whose first message is the title. A tangent
   * already followed from that message just opens its lane.
   */
  async followTangent(fromNodeId: string, title: string): Promise<Branch | null> {
    const existing = this.childBranchesAt(fromNodeId).find((b) => b.title === title);
    if (existing) {
      this.go(existing.id);
      return existing;
    }
    const branch = await this.createBranch(
      { fromNodeId, contextMode: 'path', anchorQuote: null, title },
      false,
    );
    if (branch) {
      this.go(branch.id);
      void this.send(branch.id, title);
    }
    return branch;
  }

  async updateBranch(branchId: string, req: UpdateBranchRequest): Promise<boolean> {
    try {
      this.applyBranch(await this.api.updateBranch(branchId, req));
      // The plan depends on mode, quote and model: drop the cached one.
      this.dropLineage(branchId);
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /** Deletes a lane with everything below it. The caller confirms first. */
  async deleteBranch(branchId: string): Promise<boolean> {
    const doomed = this.index()?.branches.get(branchId);
    try {
      const res = await this.api.deleteBranch(branchId);
      const selected = this.selectedBranchId();
      if (doomed?.parentBranchId && selected && res.branchIds.includes(selected)) {
        this.go(doomed.parentBranchId, doomed.branchPointNodeId, true);
      }
      this.removeBranches(res);
      this.ui.notify(
        res.branchIds.length > 1
          ? `Deleted the lane and ${res.branchIds.length - 1} below it`
          : 'Lane deleted',
      );
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  // Lineage

  /**
   * Loads what the model would see for `branchId` at its current leaf, unless
   * that plan is already cached. Summaries are not generated (that would
   * spend a model call), so a summary lane may show its summary as pending.
   */
  async loadLineage(branchId: string): Promise<void> {
    const idx = this.index();
    if (!idx || !idx.branches.has(branchId)) return;
    const leafId = branchLeaf(idx, branchId)?.id ?? null;
    const cached = this.lineages().get(branchId);
    if (cached && cached.leafId === leafId) return;
    // One request per lane and leaf: the effect calling this may re-run while
    // it is out, and a plan the server refused is not asked for again.
    const key = `${branchId}|${leafId ?? ''}`;
    if (this.lineageInFlight.has(key) || this.lineageFailed.has(key)) return;
    this.lineageInFlight.add(key);
    const seq = ++this.lineageSeq;
    this.lineageLoading.set(branchId);
    try {
      const res = await this.api.getContext(branchId, null, false);
      const lineage = toLineage(branchId, leafId, res.plan);
      // A late plan for an older leaf is still stored (`selectedLineage` checks
      // the leaf), unless it would replace the plan for the lane's current leaf.
      this.lineages.update((m) => {
        const cur = m.get(branchId);
        if (cur && cur.leafId !== leafId && cur.leafId === this.leafOf(branchId)) return m;
        return new Map(m).set(branchId, lineage);
      });
    } catch (err) {
      this.lineageFailed.add(key);
      // Informational: a lane without a plan just shows every card the same.
      console.warn('Could not load the lineage', err);
    } finally {
      this.lineageInFlight.delete(key);
      if (seq === this.lineageSeq) this.lineageLoading.set(null);
    }
  }

  private leafOf(branchId: string): string | null {
    const idx = this.index();
    return idx?.branches.has(branchId) ? (branchLeaf(idx, branchId)?.id ?? null) : null;
  }

  private dropLineage(branchId: string): void {
    // A lane's settings changed or lanes went away: plans that failed may load now.
    this.lineageFailed.clear();
    if (!this.lineages().has(branchId)) return;
    this.lineages.update((m) => {
      const next = new Map(m);
      next.delete(branchId);
      return next;
    });
  }

  // Messages and replies

  async send(branchId: string, content: string): Promise<boolean> {
    this.markSending(branchId, true);
    const ctrl = new AbortController();
    let nodeId: string | null = null;
    try {
      const outcome = await runStream(
        {
          open: (signal) => this.api.sendMessage(branchId, { content }, signal),
          reconnect: (id, signal) => this.api.streamNode(id, signal),
        },
        (event) => {
          if (event.type === 'start') {
            nodeId = event.assistantNode.id;
            this.controllers.set(nodeId, ctrl);
            this.markSending(branchId, false);
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
      this.fail(err);
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

  /** The reply generating in `branchId`, if any. */
  streamingIn(branchId: string): ChatNode | null {
    const idx = this.index();
    if (!idx) return null;
    return (idx.nodesByBranch.get(branchId) ?? []).find((n) => n.status === 'streaming') ?? null;
  }

  fail(err: unknown): void {
    console.error(err);
    if (err instanceof ApiError && err.code === 'membership_required') {
      // The shell's notice explains it and links to the power app's /billing.
      this.membership.update((m) => (m ? { ...m, required: true, status: 'inactive' } : m));
      return;
    }
    if (err instanceof ApiError && err.code === 'payment_required') {
      // Out of Tangent credit (the only metered provider here).
      this.ui.notify(errorMessage(err), 'error', { label: 'Add credit', href: '/billing' });
      void this.refreshBilling();
      return;
    }
    this.ui.notify(errorMessage(err), 'error');
    if (err instanceof ApiError && err.code === 'key_required') {
      void this.refreshKeys();
      this.ui.keysOpen.set(true);
    }
  }

  // Internals

  private markSending(branchId: string, on: boolean): void {
    if (this.sending().has(branchId) === on) return;
    this.sending.update((set) => {
      const next = new Set(set);
      if (on) next.add(branchId);
      else next.delete(branchId);
      return next;
    });
  }

  /** After loading a tree: re-attach to replies still generating server-side. */
  private resumeStreaming(nodes: readonly ChatNode[]): void {
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

  private apply(event: StreamEvent, streamNodeId: string | null): void {
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

  private finish(nodeId: string | null, outcome: StreamOutcome): void {
    if (outcome.kind === 'lost') {
      this.ui.notify(
        `Lost the connection to the reply: ${outcome.message}. Reload to check on it.`,
        'error',
      );
      if (nodeId) {
        this.markError(nodeId, 'Connection lost. Reload to see the final reply.');
        this.dropLive(nodeId);
      }
    }
    this.completions.update((n) => n + 1);
    void this.refreshAfterCompletion();
  }

  /** Titles can change after the first reply (auto-titling): refresh the list and the tree title. */
  private async refreshAfterCompletion(): Promise<void> {
    await this.loadTrees();
    const d = this.detail();
    const summary = d && this.trees().find((t) => t.id === d.tree.id);
    if (d && summary && summary.title !== d.tree.title) {
      this.detail.update((cur) =>
        cur ? { ...cur, tree: { ...cur.tree, title: summary.title } } : cur,
      );
    }
  }

  private markError(nodeId: string, message: string): void {
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

  private applyNodes(nodes: ChatNode[]): void {
    this.detail.update((d) => {
      if (!d) return d;
      const mine = nodes.filter((n) => n.treeId === d.tree.id);
      return mine.length ? { ...d, nodes: upsertById(d.nodes, mine) } : d;
    });
  }

  private applyBranch(branch: Branch): void {
    this.detail.update((d) =>
      d && d.tree.id === branch.treeId ? { ...d, branches: upsertById(d.branches, [branch]) } : d,
    );
  }

  private removeBranches(res: DeleteBranchResponse): void {
    const branchIds = new Set(res.branchIds);
    const nodeIds = new Set(res.nodeIds);
    for (const id of nodeIds) {
      this.controllers.get(id)?.abort();
      this.controllers.delete(id);
      this.dropLive(id);
    }
    for (const id of branchIds) this.dropLineage(id);
    this.detail.update((d) =>
      d && d.tree.id === res.treeId
        ? {
            ...d,
            branches: d.branches.filter((b) => !branchIds.has(b.id)),
            nodes: d.nodes.filter((n) => !nodeIds.has(n.id)),
          }
        : d,
    );
    const d = this.detail();
    if (d && d.tree.id === res.treeId) {
      this.trees.update((list) =>
        list.map((t) =>
          t.id === res.treeId
            ? { ...t, branchCount: d.branches.length, messageCount: d.nodes.length }
            : t,
        ),
      );
    }
  }

  private setLive(s: LiveReply): void {
    this.live.update((m) => new Map(m).set(s.nodeId, s));
  }

  private patchLive(nodeId: string, patch: Partial<LiveReply>): void {
    const cur = this.live().get(nodeId);
    if (cur) this.setLive({ ...cur, ...patch });
  }

  private dropLive(nodeId: string): void {
    if (!this.live().has(nodeId)) return;
    this.live.update((m) => {
      const next = new Map(m);
      next.delete(nodeId);
      return next;
    });
  }
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

/** Sorts a plan's source messages into verbatim, summarized and dropped. */
export function toLineage(branchId: string, leafId: string | null, plan: ContextPlan): Lineage {
  const verbatim = new Set<string>();
  const summarized = new Set<string>();
  for (const seg of plan.segments) {
    if (seg.kind === 'ancestor' || seg.kind === 'branch') verbatim.add(seg.nodeId);
    else if (seg.kind === 'summary') for (const id of seg.sourceNodeIds) summarized.add(id);
  }
  if (plan.compaction) for (const id of plan.compaction.compactedNodeIds) summarized.add(id);
  const dropped = new Set(plan.truncation?.droppedNodeIds ?? []);
  for (const id of summarized) verbatim.delete(id);
  for (const id of dropped) {
    verbatim.delete(id);
    summarized.delete(id);
  }
  return { branchId, leafId, plan, verbatim, summarized, dropped };
}
