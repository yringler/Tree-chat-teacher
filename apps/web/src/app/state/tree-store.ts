import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  branchChain,
  branchLeaf,
  branchPath,
  buildOutline,
  flattenOutline,
  indexTree,
  navigate,
  type NavDirection,
  type OutlineItem,
  type TreeIndex,
} from '@tangent/core';
import type {
  Branch,
  ChatNode,
  CreateBranchRequest,
  KeyStatusResponse,
  MeResponse,
  ProviderInfo,
  ShareScope,
  StreamEvent,
  TreeBackupInput,
  TreeDetail,
  TreeSummary,
  UpdateBranchRequest,
  UpdateTreeRequest,
} from '@tangent/shared';
import { ApiClient, ApiError, errorMessage } from '../core/api-client';
import { runStream, type StreamOutcome } from '../sse/stream-runner';
import { UiStore } from './ui-store';

/** Live state of a generation, kept apart from `detail` so deltas don't re-index the tree. */
export interface LiveStream {
  nodeId: string;
  treeId: string;
  branchId: string;
  content: string;
  /** Latest `status` event (e.g. "Summarizing parent context…"). */
  status: string | null;
  reconnecting: boolean;
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

/** Application state: tree list, the selected tree, selection, live streams. */
@Injectable({ providedIn: 'root' })
export class TreeStore {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly ui = inject(UiStore);

  // Global data
  readonly me = signal<MeResponse | null>(null);
  readonly providers = signal<ProviderInfo[]>([]);
  /** Which providers have a user-supplied key stored (never the key itself). */
  readonly keyStatus = signal<KeyStatusResponse | null>(null);
  readonly trees = signal<TreeSummary[]>([]);
  readonly treesLoaded = signal(false);

  // Selected tree
  readonly selectedTreeId = signal<string | null>(null);
  readonly detail = signal<TreeDetail | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);
  private readonly routeBranchId = signal<string | null>(null);
  readonly focusedNodeId = signal<string | null>(null);

  // Streams
  readonly live = signal<ReadonlyMap<string, LiveStream>>(new Map());
  /** Branch whose POST is in flight (before `start` arrives). */
  readonly sendingBranchId = signal<string | null>(null);
  /** Bumped whenever a generation finishes; the inspector refreshes on it. */
  readonly completions = signal(0);
  private readonly controllers = new Map<string, AbortController>();
  private detailSeq = 0;

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

  readonly outline = computed<OutlineItem | null>(() => {
    const idx = this.index();
    return idx ? buildOutline(idx) : null;
  });

  readonly flatOutline = computed<OutlineItem[]>(() => {
    const root = this.outline();
    return root ? flattenOutline(root) : [];
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

  readonly parentBranch = computed<Branch | null>(() => {
    const b = this.selectedBranch();
    const idx = this.index();
    return (b?.parentBranchId && idx?.branches.get(b.parentBranchId)) || null;
  });

  /** Root → leaf of the selected branch. */
  readonly path = computed<ChatNode[]>(() => {
    const idx = this.index();
    const id = this.selectedBranchId();
    return idx && id ? branchPath(idx, id) : [];
  });

  readonly chain = computed<Branch[]>(() => {
    const idx = this.index();
    const id = this.selectedBranchId();
    return idx && id ? branchChain(idx, id) : [];
  });

  readonly leaf = computed<ChatNode | null>(() => {
    const idx = this.index();
    const id = this.selectedBranchId();
    return idx && id ? branchLeaf(idx, id) : null;
  });

  /** Focused node if it is on the displayed path, else null. */
  readonly focusedInPath = computed<ChatNode | null>(() => {
    const id = this.focusedNodeId();
    return (id && this.path().find((n) => n.id === id)) || null;
  });

  /** The assistant node currently generating in the selected branch. */
  readonly streamingNode = computed<ChatNode | null>(() => {
    const id = this.selectedBranchId();
    const idx = this.index();
    if (!id || !idx) return null;
    const own = idx.nodesByBranch.get(id) ?? [];
    return own.find((n) => n.status === 'streaming') ?? null;
  });

  readonly busy = computed(() => {
    const sending = this.sendingBranchId();
    return (
      this.streamingNode() !== null || (sending !== null && sending === this.selectedBranchId())
    );
  });

  readonly providerMap = computed(() => new Map(this.providers().map((p) => [p.id, p])));

  /** First provider with an API key, falling back to the first configured. */
  readonly defaultProvider = computed<ProviderInfo | null>(
    () => this.providers().find((p) => p.available) ?? this.providers()[0] ?? null,
  );

  // Bootstrapping

  async init(): Promise<void> {
    await Promise.all([
      this.api.me().then(
        (m) => this.me.set(m),
        (e: unknown) => this.fail(e),
      ),
      this.refreshKeys(),
      this.loadTrees(),
    ]);
  }

  // API keys (bring-your-own-key)

  /** Key status and provider availability both change when a key is saved or forgotten. */
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

  /**
   * Sends the key to the Worker once. It is sealed into an HttpOnly cookie
   * and nothing here keeps a copy.
   */
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

  // Routing (URL is the source of truth for selection)

  /** Called by the routed page whenever the URL changes. */
  setRoute(treeId: string | null, branchId: string | null, focusNodeId: string | null): void {
    this.routeBranchId.set(branchId);
    this.focusedNodeId.set(focusNodeId);
    if (treeId !== this.selectedTreeId()) {
      this.selectedTreeId.set(treeId);
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
    this.ui.drawerOpen.set(false);
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

  /** j/k: move focus along the displayed path. */
  moveFocus(delta: 1 | -1): void {
    const path = this.path();
    if (path.length === 0) return;
    const current = this.focusedInPath();
    let i = current ? path.indexOf(current) + delta : delta > 0 ? 0 : path.length - 1;
    i = Math.max(0, Math.min(path.length - 1, i));
    const target = path[i];
    if (target) this.focus(target.id);
  }

  firstNodeOf(branchId: string): ChatNode | null {
    return this.index()?.nodesByBranch.get(branchId)?.[0] ?? null;
  }

  /**
   * Node a share/export of `scope` targets: the focused message when there is
   * one on the path; else the leaf (path) or the branch's first message (subtree).
   */
  targetNodeFor(scope: ShareScope): string | null {
    if (scope === 'tree') return null;
    const focused = this.focusedInPath();
    if (scope === 'path') return (focused ?? this.leaf())?.id ?? null;
    if (focused) return focused.id;
    const b = this.selectedBranch();
    if (!b) return null;
    return this.firstNodeOf(b.id)?.id ?? b.branchPointNodeId;
  }

  childBranchesAt(nodeId: string): readonly Branch[] {
    return this.index()?.branchesAtNode.get(nodeId) ?? [];
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

  /** New tree from the empty state: creates it, opens it, sends the first message. */
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
      this.trees.update((list) => [this.summaryOf(detail), ...list]);
      await this.router.navigate(['/t', detail.tree.id]);
      void this.send(detail.tree.trunkBranchId, content);
    } catch (err) {
      this.fail(err);
    }
  }

  async updateTree(req: UpdateTreeRequest): Promise<boolean> {
    const d = this.detail();
    if (!d) return false;
    try {
      const tree = await this.api.updateTree(d.tree.id, req);
      this.detail.update((cur) => (cur && cur.tree.id === tree.id ? { ...cur, tree } : cur));
      this.trees.update((list) =>
        list.map((t) =>
          t.id === tree.id ? { ...t, title: tree.title, updatedAt: tree.updatedAt } : t,
        ),
      );
      return true;
    } catch (err) {
      this.fail(err);
      return false;
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

  async importBackup(backup: TreeBackupInput): Promise<void> {
    try {
      const detail = await this.api.importBackup(backup);
      this.trees.update((list) => [this.summaryOf(detail), ...list]);
      this.ui.notify(`Imported “${detail.tree.title}”`);
      await this.router.navigate(['/t', detail.tree.id]);
    } catch (err) {
      this.fail(err);
    }
  }

  // Branches

  async createBranch(req: CreateBranchRequest): Promise<Branch | null> {
    try {
      const branch = await this.api.createBranch(req);
      this.applyBranch(branch);
      this.go(branch.id);
      this.ui.focusComposer();
      return branch;
    } catch (err) {
      this.fail(err);
      return null;
    }
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

  // Messages and streams

  async send(branchId: string, content: string): Promise<boolean> {
    this.sendingBranchId.set(branchId);
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
            this.sendingBranchId.set(null);
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
      if (this.sendingBranchId() === branchId) this.sendingBranchId.set(null);
      if (nodeId) this.controllers.delete(nodeId);
    }
  }

  async cancel(nodeId: string): Promise<void> {
    try {
      await this.api.cancelNode(nodeId);
    } catch (err) {
      this.fail(err);
    }
  }

  /** After loading a tree: re-attach to generations still running server-side. */
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
      case 'error': {
        if (event.node) this.applyNodes([event.node]);
        else if (event.nodeId) this.markError(event.nodeId, event.message);
        if (event.nodeId) this.dropLive(event.nodeId);
        break;
      }
    }
  }

  private finish(nodeId: string | null, outcome: StreamOutcome): void {
    if (outcome.kind === 'lost') {
      this.ui.notify(
        `Lost the connection to the reply: ${outcome.message}. Reload to check on it.`,
        'error',
      );
      if (nodeId) {
        // Unblock the composer; the server rejects a racing send with 409 if it is still generating.
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

  private setLive(s: LiveStream): void {
    this.live.update((m) => new Map(m).set(s.nodeId, s));
  }

  private patchLive(nodeId: string, patch: Partial<LiveStream>): void {
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

  private summaryOf(d: TreeDetail): TreeSummary {
    return {
      id: d.tree.id,
      title: d.tree.title,
      createdAt: d.tree.createdAt,
      updatedAt: d.tree.updatedAt,
      branchCount: d.branches.length,
      messageCount: d.nodes.length,
    };
  }

  fail(err: unknown): void {
    console.error(err);
    this.ui.notify(errorMessage(err), 'error');
    if (err instanceof ApiError && err.code === 'key_required') {
      // Missing, expired or reset key: ask for it for the provider in use.
      void this.refreshKeys();
      if (!this.ui.keysDialog()) {
        this.ui.keysDialog.set({ provider: this.selectedBranch()?.providerId ?? null });
      }
    }
  }
}
