import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  branchChain,
  branchLeaf,
  branchesWithLinks,
  branchPath,
  buildOutline,
  flattenOutline,
  indexLinks,
  indexTree,
  linkTarget,
  navigate,
  type NavDirection,
  type OutlineItem,
  type TreeIndex,
} from '@tangent/core';
import {
  checkSourcesMessage,
  isModelAllowed,
  parseRouteKey,
  pickDefaultRoute,
  providerRouteKey,
  routeKey,
  type BranchFunding,
} from '@tangent/shared';
import type {
  BillingSummary,
  Branch,
  ChatNode,
  CommitCandidateResponse,
  CreateBranchRequest,
  DeleteBranchResponse,
  KeyStatusResponse,
  MeResponse,
  MembershipInfo,
  NodeLink,
  ProviderInfo,
  ShareScope,
  StreamEvent,
  TreeBackupInput,
  TreeDetail,
  TreeSummary,
  UpdateBranchRequest,
  UpdateTreeRequest,
} from '@tangent/shared';
import {
  addBlockedSend,
  ApiClient,
  ApiError,
  creditBuyable,
  creditCanPay,
  creditCarriesOn,
  errorMessage,
  isNotFound,
  keyMissing,
  learnCopyWay,
  lockedFundings,
  routeLocked,
  routeOpen,
  runStream,
  type BlockedSend,
  type LearnCopyWay,
  type StreamOutcome,
} from '@tangent/web-shared';
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
  /** The provider list has been read once (until then nothing is known to be unable to generate). */
  readonly providersLoaded = signal(false);
  /** Which providers have a user-supplied key stored (never the key itself). */
  readonly keyStatus = signal<KeyStatusResponse | null>(null);
  /**
   * The yearly membership, from `me`; a 402 `membership_required` marks it
   * inactive (the server knows better than the copy fetched at startup).
   */
  readonly membership = signal<MembershipInfo | null>(null);
  /**
   * Credit balance and fees (`/api/billing`): read on startup wherever credit
   * is offered (the default route needs the balance), again when the keys
   * dialog opens and after a 402.
   */
  readonly billing = signal<BillingSummary | null>(null);
  /** The balance has been asked for once (read, or failed: then it counts as none). */
  private readonly billingRead = signal(false);
  /**
   * The open pool is on (`GET /api/pool/status`, read on startup): Learn can
   * then reply without a membership or credit. False until read, or when it
   * can't be.
   */
  readonly poolOn = signal(false);
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
  /**
   * Messages the server refused for want of their branch's own API key (401
   * `key_required`, before anything was written), while the keys dialog asks
   * how to carry on: Tangent credit (`resumeOnCredit`) or the key
   * (`resumeAfterKey`) sends them; closing the dialog just forgets them
   * (`dropBlockedSends`): the text is still in the composer (`unsentDrafts`).
   */
  readonly blockedSends = signal<readonly BlockedSend[]>([]);
  /**
   * Messages that didn't reach the server's tree (any error before the reply
   * started: a missing key, no credit, a network failure…), by branch. The
   * composer of that branch takes the text back when its box is empty
   * (`Composer.initial`), so a message typed elsewhere (a tangent, "Ask your
   * own", the branch dialog, a new conversation) is not lost either. Dropped
   * when the branch sends again.
   */
  readonly unsentDrafts = signal<ReadonlyMap<string, string>>(new Map());
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

  /** The tree's links between messages, oldest first. */
  readonly links = computed<readonly NodeLink[]>(() => this.detail()?.links ?? []);

  /** Links by node id, each link under both of its ends. */
  readonly linksByNode = computed<ReadonlyMap<string, readonly NodeLink[]>>(() =>
    indexLinks(this.links()),
  );

  /** How many links touch each branch's messages (outline badges). */
  readonly linkCounts = computed<ReadonlyMap<string, number>>(() => {
    const idx = this.index();
    return idx ? branchesWithLinks(idx, this.linksByNode()) : new Map<string, number>();
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

  /**
   * The fundings that need the membership in this account, from `me` (the
   * server's rule: `['own-key']` where a membership is required). With
   * `membership`, they decide which branches are read-only.
   */
  readonly membershipNeededFor = signal<readonly BranchFunding[]>([]);

  /** The fundings the user can't generate on right now (docs/DECISIONS.md "Read-only power"). */
  readonly lockedFundings = computed(() =>
    lockedFundings(this.membershipNeededFor(), this.membership()),
  );

  /**
   * Tangent credit can pay for replies, membership or not (`creditCarriesOn`:
   * offered, and either top-ups are sold, so anyone can buy more, or the
   * balance isn't known to be used up). Without a membership, power mode
   * runs on it.
   */
  readonly creditCarriesOn = computed(() =>
    creditCarriesOn(this.me()?.builtInCredit ?? false, this.billing()),
  );

  /**
   * How a copy in Learn of a read-only conversation would get replies without
   * a membership (`learnCopyWay`): the open pool while it is on, else Tangent
   * credit while it carries on; null when neither, and the read-only notice
   * then offers no copy.
   */
  readonly learnCopyWay = computed<LearnCopyWay | null>(() =>
    learnCopyWay(this.poolOn(), this.creditCarriesOn()),
  );

  /** A route (branch, reviewer, provider entry) whose funding needs the membership the user lacks. */
  routeLocked(route: { funding?: BranchFunding }): boolean {
    return routeLocked(this.lockedFundings(), route);
  }

  /** Provider entries the user can generate on now (see `routeOpen`). */
  readonly openRoutes = computed(() =>
    this.providers().filter((p) => routeOpen(p, this.lockedFundings(), this.creditCarriesOn())),
  );

  /**
   * Something can still generate: new conversations, new branches and reviews
   * are offered. False only when the membership locks something and no other
   * route is open (a non-member with their own keys, where Tangent credit
   * isn't sold, or top-ups are off and none is left): power is then
   * read-only throughout. A missing key alone never hides
   * anything (sending asks for it), nor does a provider list not read yet.
   */
  readonly canGenerate = computed(
    () =>
      this.lockedFundings().size === 0 || !this.providersLoaded() || this.openRoutes().length > 0,
  );

  /**
   * The selected branch is read-only: its funding needs the membership the
   * user lacks. Its composer becomes the notice (renew, copy to Learn).
   */
  readonly readOnly = computed(() => {
    const b = this.selectedBranch();
    return !!b && this.routeLocked(b);
  });

  /** Tangent credit, when a read-only branch could carry on with it (anyone can buy it). */
  readonly creditRoute = computed<ProviderInfo | null>(
    () => this.openRoutes().find((p) => p.funding === 'credit') ?? null,
  );

  /**
   * A route (a branch) on the user's own key with none saved in this browser
   * (`keyMissing`): sending there asks for the key, or another way to pay.
   */
  keyMissing(route: { providerId: string; funding?: BranchFunding }): boolean {
    return keyMissing(this.providerOf(route));
  }

  /** The branch of the latest blocked send, while one waits (the keys dialog's notice). */
  readonly blockedBranch = computed<Branch | null>(() => {
    const s = this.blockedSends().at(-1);
    return (s && this.index()?.branches.get(s.branchId)) || null;
  });

  /** A review of a reply in `branch`: the branch's summaries and the reviewer both need an open route. */
  canReview(branch: { funding?: BranchFunding } | null): boolean {
    return !!branch && !this.routeLocked(branch) && this.canGenerate();
  }

  /**
   * Providers by route (`routeKey`): a plain provider id for the user's own
   * key, `<id>@credit` for Tangent credit (power lists the built-in endpoint
   * on both).
   */
  readonly providerMap = computed(
    () => new Map(this.providers().map((p) => [providerRouteKey(p), p])),
  );

  /** The provider entry of a route: a branch, a reviewer, a context plan. */
  providerOf(route: { providerId: string; funding?: BranchFunding }): ProviderInfo | undefined {
    return this.providerMap().get(routeKey(route));
  }

  /**
   * The route a new conversation starts on, and the fallback of a new branch
   * off a locked one: `pickDefaultRoute`, the server's rule for a new tree
   * (docs/DECISIONS.md "Default route of a new tree"). A provider with a key
   * first; else Tangent credit while the balance can pay; else the user's own
   * OpenRouter (the first send asks for its key). While own keys need a
   * membership the user lacks, credit comes first if it can pay or be bought
   * (`creditBuyable`: offered and top-ups sold), whatever the balance: a first
   * send there asks for credit, which beats a locked own key. Credit that can
   * do neither leaves the locked own key, which at least leads to the
   * membership. Null until the provider list and, where credit is offered,
   * the balance have been read, so it never starts on a guess.
   */
  readonly defaultProvider = computed<ProviderInfo | null>(() => {
    if (!this.providersLoaded()) return null;
    const builtInCredit = this.me()?.builtInCredit ?? false;
    if (builtInCredit && !this.billingRead()) return null;
    const ownKeyLocked = this.lockedFundings().has('own-key');
    return pickDefaultRoute(this.providers(), {
      creditCanPay: creditCanPay(builtInCredit, this.billing()),
      creditBuyable: creditBuyable(builtInCredit, this.billing()),
      ownKeyLocked,
    });
  });

  // Bootstrapping

  /** `me`: the signed-in caller, already fetched by the sign-in check (AuthService.requireUser). */
  async init(me: MeResponse): Promise<void> {
    this.applyMe(me);
    // Where credit is offered, the balance (and whether top-ups are sold) decides whether a
    // new conversation may start on it, and whether Tangent credit can carry on.
    const balance = me.builtInCredit ? this.refreshBilling() : null;
    await Promise.all([this.refreshKeys(), this.loadTrees(), balance, this.refreshPool()]);
  }

  private applyMe(me: MeResponse): void {
    this.me.set(me);
    this.membership.set(me.membership);
    this.membershipNeededFor.set(me.membershipNeededFor ?? []);
  }

  /** Re-reads `me`: the membership and the fundings that need it, as the server sees them now. */
  async refreshMe(): Promise<void> {
    try {
      this.applyMe(await this.api.me());
    } catch (err) {
      console.warn('me failed', err);
    }
  }

  // API keys (bring-your-own-key)

  /** Key status and provider availability both change when a key is saved or forgotten. */
  async refreshKeys(): Promise<void> {
    await Promise.all([
      this.api.keyStatus().then(
        (s) => this.keyStatus.set(s),
        (e: unknown) => this.fail(e),
      ),
      this.api
        .providers()
        .then(
          (p) => this.providers.set(p),
          (e: unknown) => this.fail(e),
        )
        .finally(() => this.providersLoaded.set(true)),
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

  /**
   * Whether the open pool is on (`/api/pool/status` is public). Quiet on
   * failure: no copy in Learn is offered on its account.
   */
  async refreshPool(): Promise<void> {
    try {
      this.poolOn.set((await this.api.poolStatus()).enabled);
    } catch (err) {
      console.warn('pool status failed', err);
    }
  }

  /** Credit balance and fees. Quiet on failure: the keys dialog then shows no balance. */
  async refreshBilling(): Promise<void> {
    try {
      this.billing.set(await this.api.billing());
    } catch (err) {
      console.warn('billing summary failed', err);
    } finally {
      this.billingRead.set(true);
    }
  }

  /** A billing summary read elsewhere (the billing page): its balance and membership are current. */
  applyBilling(summary: BillingSummary): void {
    this.billing.set(summary);
    this.billingRead.set(true);
    this.membership.set(summary.membership);
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
      this.ui.clearLinkState();
      // A comparison belongs to a branch of the tree left behind (Back while it was open).
      this.ui.compareDialog.set(null);
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

  /**
   * New tree from the empty state: creates it, opens it, sends the first
   * message. `route` is a `routeKey` (provider and funding), null for the default.
   */
  async startConversation(
    content: string,
    route: string | null,
    model: string | null,
  ): Promise<void> {
    try {
      const detail = await this.api.createTree({
        ...(route ? parseRouteKey(route) : {}),
        ...(model ? { model } : {}),
      });
      this.detail.set(detail);
      this.selectedTreeId.set(detail.tree.id);
      this.ui.clearLinkState();
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

  /**
   * Deletes a whole conversation (not a generating call: it stays available
   * while power is read-only). If it is open, goes home. The caller confirms
   * first. Resolves true if it was deleted.
   */
  async deleteTree(treeId: string): Promise<boolean> {
    try {
      await this.api.deleteTree(treeId);
      this.trees.update((list) => list.filter((t) => t.id !== treeId));
      if (this.selectedTreeId() === treeId) await this.router.navigate(['/']);
      this.ui.notify('Conversation deleted');
      return true;
    } catch (err) {
      this.fail(err);
      return false;
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

  /**
   * Follows a tangent the assistant suggested under `fromNodeId`: a `path`
   * branch titled after it (a user title, so auto-titling keeps it), on the
   * message's branch's provider and model like "Branch from here", whose
   * first message is the title. A tangent already followed from that message
   * just opens its branch.
   */
  async followTangent(fromNodeId: string, title: string): Promise<Branch | null> {
    const existing = this.childBranchesAt(fromNodeId).find((b) => b.title === title);
    if (existing) {
      this.go(existing.id, this.firstNodeOf(existing.id)?.id ?? null);
      return existing;
    }
    return this.startBranch({ fromNodeId, contextMode: 'path', anchorQuote: null, title }, title);
  }

  /**
   * "Ask your own" under a reply: the user's question, asked like a followed
   * tangent (a `path` branch on the message's provider and model). Untitled:
   * it reads "Branch: …" until the first reply names it (auto-titling).
   */
  askFrom(fromNodeId: string, content: string): Promise<Branch | null> {
    return this.startBranch({ fromNodeId, contextMode: 'path', anchorQuote: null }, content);
  }

  /**
   * Creates a branch, opens it and sends `content` as its first message.
   * Resolves once the branch exists (null if it could not be created); the
   * reply streams on.
   */
  async startBranch(req: CreateBranchRequest, content: string): Promise<Branch | null> {
    try {
      const branch = await this.api.createBranch(req);
      this.applyBranch(branch);
      this.go(branch.id);
      void this.send(branch.id, content);
      return branch;
    } catch (err) {
      this.fail(err);
      return null;
    }
  }

  /** Depth of a branch: 0 for the main thread, 1 for a branch of it, … */
  depthOf(branchId: string): number {
    const idx = this.index();
    return idx ? Math.max(0, branchChain(idx, branchId).length - 1) : 0;
  }

  /** Whether replies in `branchId` can be checked against web sources (its provider can search). */
  canCheckSources(branchId: string): boolean {
    const branch = this.index()?.branches.get(branchId);
    if (!branch) return false;
    return this.providers().some(
      (p) =>
        p.id === branch.providerId &&
        (p.funding ?? 'own-key') === branch.funding &&
        p.webSearch === true,
    );
  }

  /**
   * "Check sources" on a finished reply: a web-searched check of it. After
   * the branch's last reply it is appended there; on an earlier reply it
   * opens a `path` branch, so later messages keep their place.
   */
  async checkSources(nodeId: string): Promise<boolean> {
    const idx = this.index();
    const node = idx?.nodes.get(nodeId);
    if (!idx || !node || node.role !== 'assistant') return false;
    const parent = node.parentId ? idx.nodes.get(node.parentId) : undefined;
    const content = checkSourcesMessage(parent?.role === 'user' ? parent.content : null);
    if ((idx.nodesByBranch.get(node.branchId) ?? []).at(-1)?.id === node.id) {
      return this.send(node.branchId, content, { ground: 'required' });
    }
    try {
      const branch = await this.api.createBranch({
        fromNodeId: node.id,
        contextMode: 'path',
        anchorQuote: null,
        title: 'Checking sources',
      });
      this.applyBranch(branch);
      this.go(branch.id);
      return await this.send(branch.id, content, { ground: 'required' });
    } catch (err) {
      this.fail(err);
      return false;
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

  /**
   * "Continue with Tangent credit" on a read-only branch: moves it onto
   * credit, keeping its model where credit offers it (the built-in endpoint
   * on the user's own key), else on credit's default model.
   */
  async switchToCredit(branchId: string): Promise<boolean> {
    const credit = this.creditRoute();
    const branch = this.index()?.branches.get(branchId);
    if (!credit || !branch) return false;
    const model =
      branch.providerId === credit.id && isModelAllowed(credit, branch.model)
        ? branch.model
        : credit.defaultModel;
    const ok = await this.updateBranch(branch.id, {
      providerId: credit.id,
      funding: 'credit',
      model,
    });
    if (ok) {
      const label = credit.models.find((m) => m.id === model)?.label ?? model;
      this.ui.notify(`“${branch.title}” now uses Tangent credit (${label})`);
      this.ui.focusComposer();
    }
    return ok;
  }

  /**
   * "Continue on Tangent credit" in the keys dialog, after a send was refused
   * for want of the branch's own key: moves each waiting branch onto credit
   * (`switchToCredit`), closes the dialog and sends its message there.
   */
  async resumeOnCredit(): Promise<boolean> {
    const waiting = this.blockedSends();
    if (waiting.length === 0) return false;
    let all = true;
    for (const s of waiting) {
      if (!(await this.switchToCredit(s.branchId))) {
        all = false;
        continue;
      }
      this.blockedSends.update((list) => list.filter((w) => w !== s));
      void this.send(s.branchId, s.content, s.ground ? { ground: s.ground } : {});
    }
    if (all) this.ui.keysDialog.set(null);
    return all;
  }

  /**
   * A key was saved for `provider`: the waiting messages of branches on it,
   * with the user's own key, are sent; the dialog closes once none waits.
   */
  resumeAfterKey(provider: string): void {
    const branches = this.index()?.branches;
    const ready = this.blockedSends().filter((s) => {
      const b = branches?.get(s.branchId);
      return !!b && b.providerId === provider && b.funding === 'own-key' && !this.keyMissing(b);
    });
    if (ready.length === 0) return;
    this.blockedSends.update((list) => list.filter((s) => !ready.includes(s)));
    for (const s of ready)
      void this.send(s.branchId, s.content, s.ground ? { ground: s.ground } : {});
    if (this.blockedSends().length === 0) this.ui.keysDialog.set(null);
  }

  /**
   * The keys dialog closed with messages still waiting: nothing is sent. Their
   * text stays in the composer (`unsentDrafts`), to send once the branch's
   * settings are changed.
   */
  dropBlockedSends(): void {
    if (this.blockedSends().length > 0) this.blockedSends.set([]);
  }

  /**
   * Deletes a branch with everything below it. If the selection is inside it,
   * moves to the message it branched from. The caller confirms first.
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
      this.ui.notify(
        res.branchIds.length > 1
          ? `Deleted the branch and ${res.branchIds.length - 1} below it`
          : 'Branch deleted',
      );
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  // Links between messages

  /**
   * Links two messages of the open tree (not a generating call: it stays
   * available while power is read-only). Two messages already linked, either
   * way round, keep their link. Opens the "N related" list at both ends.
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
      this.ui.setRelatedOpen([fromNodeId, toNodeId], true);
      this.ui.notify(created ? 'Messages linked' : 'Already linked');
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
      this.ui.notify('Link removed');
      return true;
    } catch (err) {
      // Removed elsewhere already (another tab, or Canvas): the same outcome.
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
  }

  /** A link the server no longer has (removed elsewhere): drop its chips here too. */
  private dropGoneLink(linkId: string): void {
    this.dropLink(linkId);
    this.ui.notify('That link was already removed');
  }

  /**
   * Opens a link's other end: its branch, focused on the message. Remembers
   * where it was opened from (`fromNodeId`, else the focused message) for
   * the header's "Back to ‘…’" pill; the browser's Back works as well.
   */
  openNode(nodeId: string, fromNodeId: string | null = null): boolean {
    const idx = this.index();
    const target = idx ? linkTarget(idx, nodeId) : null;
    const here = this.selectedBranch();
    if (!target || !here) return false;
    this.ui.linkReturn.set({
      branchId: here.id,
      focusNodeId: fromNodeId ?? this.focusedInPath()?.id ?? null,
      label: here.title,
      toBranchId: target.branchId,
      toNodeId: nodeId,
    });
    this.ui.setRelatedOpen([nodeId], true);
    this.go(target.branchId, target.focusNodeId);
    return true;
  }

  // Messages and streams

  async send(
    branchId: string,
    content: string,
    options: { ground?: 'required' } = {},
  ): Promise<boolean> {
    this.sendingBranchId.set(branchId);
    if (this.blockedSends().some((s) => s.branchId === branchId)) {
      this.blockedSends.update((list) => list.filter((s) => s.branchId !== branchId));
    }
    this.setUnsentDraft(branchId, null);
    const ctrl = new AbortController();
    let nodeId: string | null = null;
    try {
      const outcome = await runStream(
        {
          open: (signal) => this.api.sendMessage(branchId, { content, ...options }, signal),
          reconnect: (id, signal) => this.api.streamNode(id, signal),
        },
        (event) => {
          if (event.type === 'start') {
            nodeId = event.assistantNode.id;
            this.controllers.set(nodeId, ctrl);
            this.sendingBranchId.set(null);
            // In the tree now: the composer may let the text go.
            this.ui.markSent(content);
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
      if (nodeId === null) {
        // Refused before anything was written: the text goes back to the branch's
        // composer (not a "Check sources" request, which the user didn't type) and,
        // for want of the key, waits for the keys dialog to carry it on.
        if (!options.ground) this.setUnsentDraft(branchId, content);
        if (err instanceof ApiError && err.code === 'key_required') {
          this.blockedSends.update((list) =>
            addBlockedSend(list, { branchId, content, ...options }),
          );
        }
      }
      this.fail(err);
      return false;
    } finally {
      if (this.sendingBranchId() === branchId) this.sendingBranchId.set(null);
      if (nodeId) this.controllers.delete(nodeId);
    }
  }

  /**
   * A Compare pick the server committed (`POST …/candidates/:id/commit`): the
   * question and the kept answer join the tree as a finished send's `start`
   * and `done` would add them, and the same refresh follows (auto-titling).
   */
  applyCommitted(result: CommitCandidateResponse): void {
    const { userNode, assistantNode, branch } = result;
    this.setUnsentDraft(branch.id, null);
    this.apply({ type: 'start', userNode, assistantNode, branch }, null);
    this.apply({ type: 'done', node: assistantNode, branch }, assistantNode.id);
    this.finish(assistantNode.id, { kind: 'done' });
  }

  private setUnsentDraft(branchId: string, text: string | null): void {
    const cur = this.unsentDrafts();
    if (text === null ? !cur.has(branchId) : cur.get(branchId) === text) return;
    const next = new Map(cur);
    if (text === null) next.delete(branchId);
    else next.set(branchId, text);
    this.unsentDrafts.set(next);
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

  private applyLinks(links: NodeLink[]): void {
    this.detail.update((d) => {
      if (!d) return d;
      const mine = links.filter((l) => l.treeId === d.tree.id);
      return mine.length ? { ...d, links: upsertById(d.links, mine) } : d;
    });
  }

  private removeBranches(res: DeleteBranchResponse): void {
    const branchIds = new Set(res.branchIds);
    const nodeIds = new Set(res.nodeIds);
    // Their generations were stopped server-side; stop following them here too.
    for (const id of nodeIds) {
      this.controllers.get(id)?.abort();
      this.controllers.delete(id);
      this.dropLive(id);
    }
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
    if (this.blockedSends().some((s) => branchIds.has(s.branchId))) {
      this.blockedSends.update((list) => list.filter((s) => !branchIds.has(s.branchId)));
    }
    for (const id of branchIds) this.setUnsentDraft(id, null);
    // Linking from a message that is gone, or back to a branch that is.
    for (const s of [this.ui.linkPick, this.ui.linkDialog]) {
      const from = s()?.fromNodeId;
      if (from !== undefined && nodeIds.has(from)) s.set(null);
    }
    const back = this.ui.linkReturn();
    if (back && (branchIds.has(back.branchId) || branchIds.has(back.toBranchId))) {
      this.ui.linkReturn.set(null);
    }
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
    if (err instanceof ApiError && err.code === 'membership_required') {
      // The server knows better than the copy read at startup: own keys are
      // locked now (the only funding it asks the membership for), and `me`
      // brings the rest. A read-only branch's notice explains it; anything
      // else (a review, say) gets a toast linking to the billing page.
      this.membership.update((m) => (m ? { ...m, required: true, status: 'inactive' } : m));
      this.membershipNeededFor.update((f) => (f.includes('own-key') ? f : [...f, 'own-key']));
      void this.refreshMe();
      void this.refreshBilling();
      if (!this.readOnly())
        this.ui.notify(errorMessage(err), 'error', { label: 'Membership', path: '/billing' });
      return;
    }
    if (err instanceof ApiError && err.code === 'payment_required') {
      // Power's only metered provider is Tangent credit: this means the credit ran out.
      this.ui.notify(errorMessage(err), 'error', { label: 'Add credit', path: '/billing' });
      void this.refreshBilling();
      return;
    }
    this.ui.notify(errorMessage(err), 'error');
    if (err instanceof ApiError && err.code === 'key_required') {
      // Missing, expired or reset key: ask for it for the provider in use (the
      // dialog also offers Tangent credit for a refused send, `blockedSends`).
      void this.refreshKeys();
      if (!this.ui.keysDialog()) {
        const branch = this.blockedBranch() ?? this.selectedBranch();
        this.ui.keysDialog.set({ provider: branch?.providerId ?? null });
      }
    }
  }
}
