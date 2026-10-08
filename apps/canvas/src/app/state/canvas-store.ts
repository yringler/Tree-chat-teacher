import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { indexLinks, linkTarget } from '@tangent/core/links';
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
import {
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
  ContextMode,
  ContextPlan,
  CreateBranchRequest,
  DeleteBranchResponse,
  KeyStatusResponse,
  MeResponse,
  MembershipInfo,
  NodeLink,
  ProviderInfo,
  StreamEvent,
  TreeDetail,
  TreeSummary,
  UpdateBranchRequest,
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
  membershipBlocks,
  routeLocked,
  routeOpen,
  runStream,
  type BlockedSend,
  type LearnCopyWay,
  type StreamOutcome,
} from '@tangent/web-shared';
import { laneTitle } from '../canvas/titles';
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
  /** Who pays: the user's own key, or Tangent credit. */
  funding: BranchFunding;
  model: string;
}

export interface FanOutRequest {
  fromNodeId: string;
  anchorQuote: string | null;
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

/**
 * Short label of a model id: its listed label on the route's provider (or, for
 * a reply, which records no funding, any entry of that provider), else the
 * part after the last `/` (OpenRouter ids).
 */
export function modelLabel(
  providers: readonly ProviderInfo[],
  route: { providerId: string; funding?: BranchFunding },
  model: string,
) {
  const key = routeKey(route);
  const p =
    providers.find((x) => providerRouteKey(x) === key) ??
    providers.find((x) => x.id === route.providerId);
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

  /** The tree's links between messages, oldest first. */
  readonly links = computed<readonly NodeLink[]>(() => this.detail()?.links ?? []);

  /** Links by node id, each link under both of its ends. */
  readonly linksByNode = computed<ReadonlyMap<string, readonly NodeLink[]>>(() =>
    indexLinks(this.links()),
  );

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

  /** The server refused an own-key call for want of a membership (402 `membership_required`). */
  private readonly noticeForced = signal(false);

  /**
   * Tangent credit can pay, membership or not, so Canvas (power mode) runs on
   * it without one (`creditCarriesOn`: offered, and either top-ups are sold,
   * so anyone can buy more, or the balance isn't known to be used up).
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

  /**
   * The shell shows a notice linking to `/billing`: the membership is
   * required and the user has none, and either no credit can carry on or the
   * server just refused an own-key call.
   */
  readonly membershipBlocked = computed(
    () => membershipBlocks(this.membership()) && (this.noticeForced() || !this.creditCarriesOn()),
  );

  /** The notice may be dismissed: Tangent credit can still pay (it needs no membership). */
  readonly membershipDismissible = computed(() => this.creditCarriesOn());

  dismissMembershipNotice(): void {
    this.noticeForced.set(false);
  }

  /**
   * The fundings that need the membership in this account, from `me` (the
   * server's rule: `['own-key']` where a membership is required).
   */
  readonly membershipNeededFor = signal<readonly BranchFunding[]>([]);

  /** The fundings the user can't generate on right now (docs/DECISIONS.md "Read-only power"). */
  readonly lockedFundings = computed(() =>
    lockedFundings(this.membershipNeededFor(), this.membership()),
  );

  /**
   * A lane (or any route) whose funding needs the membership the user lacks:
   * read-only, its composer replaced by the notice (renew, copy to Learn).
   */
  routeLocked(route: { funding?: BranchFunding }): boolean {
    return routeLocked(this.lockedFundings(), route);
  }

  /** Tangent credit, when a read-only lane could carry on with it (anyone can buy it). */
  readonly creditRoute = computed<ProviderInfo | null>(
    () =>
      this.providers().find(
        (p) =>
          p.funding === 'credit' && routeOpen(p, this.lockedFundings(), this.creditCarriesOn()),
      ) ?? null,
  );

  /**
   * "Continue with Tangent credit" on a read-only lane: moves it onto credit,
   * keeping its model where credit offers it, else on credit's default model.
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
    if (ok) this.ui.notify(`“${branch.title}” now uses Tangent credit`);
    return ok;
  }

  /**
   * Messages the server refused for want of their lane's own API key (401
   * `key_required`, before anything was written; a fan-out can leave several),
   * while the keys dialog asks how to carry on: Tangent credit
   * (`resumeOnCredit`) or the key (`resumeAfterKey`) sends them; closing the
   * dialog just forgets them: the text stays in the lanes' boxes (`unsentDrafts`).
   */
  readonly blockedSends = signal<readonly BlockedSend[]>([]);
  /**
   * Messages that didn't reach the tree (any error before the reply started),
   * by lane: the lane's box takes the text back when empty
   * (`LaneComposer.initial`), so one sent from elsewhere (a tangent, a
   * fan-out, "Ask your own") is not lost either. Dropped when the lane sends again.
   */
  readonly unsentDrafts = signal<ReadonlyMap<string, string>>(new Map());

  /** The lane of the latest blocked send, while one waits (the keys dialog's notice). */
  readonly blockedBranch = computed<Branch | null>(() => {
    const s = this.blockedSends().at(-1);
    return (s && this.index()?.branches.get(s.branchId)) || null;
  });

  /** A lane on the user's own key with none saved in this browser (`keyMissing`). */
  keyMissing(route: { providerId: string; funding?: BranchFunding }): boolean {
    return keyMissing(this.providerMap().get(routeKey(route)));
  }

  /**
   * "Continue on Tangent credit" in the keys dialog: moves every waiting lane
   * onto credit (`switchToCredit`), closes the dialog and sends their messages.
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
      void this.send(s.branchId, s.content);
    }
    if (all) this.ui.keysOpen.set(false);
    return all;
  }

  /** A key was saved for `provider`: the waiting messages of lanes on it are sent. */
  resumeAfterKey(provider: string): void {
    const branches = this.index()?.branches;
    const ready = this.blockedSends().filter((s) => {
      const b = branches?.get(s.branchId);
      return !!b && b.providerId === provider && b.funding === 'own-key' && !this.keyMissing(b);
    });
    if (ready.length === 0) return;
    this.blockedSends.update((list) => list.filter((s) => !ready.includes(s)));
    for (const s of ready) void this.send(s.branchId, s.content);
    if (this.blockedSends().length === 0) this.ui.keysOpen.set(false);
  }

  /** The keys dialog closed with messages still waiting: nothing is sent (their text stays, `unsentDrafts`). */
  dropBlockedSends(): void {
    if (this.blockedSends().length > 0) this.blockedSends.set([]);
  }

  private setUnsentDraft(branchId: string, text: string | null): void {
    const cur = this.unsentDrafts();
    if (text === null ? !cur.has(branchId) : cur.get(branchId) === text) return;
    const next = new Map(cur);
    if (text === null) next.delete(branchId);
    else next.set(branchId, text);
    this.unsentDrafts.set(next);
  }

  /** Providers by route (`routeKey`): the built-in endpoint is listed on the user's key and on Tangent credit. */
  readonly providerMap = computed(
    () => new Map(this.providers().map((p) => [providerRouteKey(p), p])),
  );

  /**
   * The route a new conversation (and a lane with no parent route) starts on:
   * `pickDefaultRoute`, the server's and the power app's rule for a new tree
   * (docs/DECISIONS.md "Default route of a new tree"). While own keys need a
   * membership the user lacks, credit comes first if it can pay or be bought
   * (`creditBuyable`: offered and top-ups sold), whatever the balance: a first
   * send there asks for credit, which beats a locked own key. Credit that can
   * do neither leaves the locked own key, which at least leads to the
   * membership. Null until the providers and, where credit is offered, the
   * balance have been read.
   */
  readonly defaultProvider = computed<ProviderInfo | null>(() => {
    const builtInCredit = this.me()?.builtInCredit ?? false;
    if (builtInCredit && !this.billingRead()) return null;
    const ownKeyLocked = this.lockedFundings().has('own-key');
    return pickDefaultRoute(this.providers(), {
      creditCanPay: creditCanPay(builtInCredit, this.billing()),
      creditBuyable: creditBuyable(builtInCredit, this.billing()),
      ownKeyLocked,
    });
  });

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
    this.applyMe(me);
    // Where credit is offered, the balance (and whether top-ups are sold) decides whether a
    // new conversation may start on it, and without a membership whether the notice shows on load.
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
    const back = this.ui.linkReturn();
    if (back && back.branchId === this.selectedBranchId() && back.nodeId === focusNodeId) {
      // Back where the link was followed from (the pill or the browser's Back).
      this.ui.linkReturn.set(null);
    }
    if (treeId !== this.selectedTreeId()) {
      this.selectedTreeId.set(treeId);
      this.ui.clearLinkState();
      this.lineages.set(new Map());
      this.lineageFailed.clear();
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

  /**
   * Follows a link to `nodeId`: unfolds the lanes on the way (a folded
   * ancestor hides it), then selects its lane focused on the card. Remembers
   * where it was followed from (`fromNodeId`, else the focused card, else
   * the selected lane) for the canvas bar's "Back to ‘…’"; the browser's
   * Back works as well.
   */
  openNode(nodeId: string, fromNodeId: string | null = null): boolean {
    const idx = this.index();
    const target = idx ? linkTarget(idx, nodeId) : null;
    const here = this.selectedBranch();
    if (!idx || !target || !here) return false;
    this.ui.expand(branchChain(idx, target.branchId).map((b) => b.id));
    const fromId = fromNodeId ?? this.focusedNodeId();
    const from = fromId !== null ? idx.nodes.get(fromId) : undefined;
    // Back to the lane of the message it was followed from (a link's other end may be anywhere).
    const back = (from && idx.branches.get(from.branchId)) ?? here;
    this.ui.linkReturn.set({
      branchId: back.id,
      nodeId: from?.id ?? null,
      label: laneTitle(back),
      toBranchId: target.branchId,
    });
    this.ui.linkPopover.set(null);
    this.go(target.branchId, target.focusNodeId);
    return true;
  }

  /** "Back to ‘…’": returns to where the latest link was followed from. */
  goBackFromLink(): void {
    const back = this.ui.linkReturn();
    if (!back) return;
    this.ui.linkReturn.set(null);
    this.go(back.branchId, back.nodeId);
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
      if (!this.loadCurrent(seq, treeId)) return;
      this.detail.set(detail);
      this.resumeStreaming(detail.nodes);
    } catch (err) {
      if (!this.loadCurrent(seq, treeId)) return;
      this.detailError.set(
        err instanceof ApiError && err.status === 404
          ? 'This conversation does not exist.'
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

  /**
   * New tree from the home page: creates it, opens it, sends the first
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
      this.showDetail(detail);
      this.selectedTreeId.set(detail.tree.id);
      this.ui.clearLinkState();
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
      this.stopTreeStreams(treeId);
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
        this.ui.focusComposer(branch.id);
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
   * Several lanes are told apart by their model and mode; a single one is
   * titled after its first reply (auto-titling).
   */
  async fanOut(req: FanOutRequest): Promise<Branch[]> {
    const several = req.variants.length > 1;
    const created: Branch[] = [];
    for (const v of req.variants) {
      const title = several ? `${modelLabel(this.providers(), v, v.model)} · ${v.contextMode}` : '';
      const branch = await this.createBranch(
        {
          fromNodeId: req.fromNodeId,
          contextMode: v.contextMode,
          anchorQuote: req.anchorQuote,
          providerId: v.providerId,
          funding: v.funding,
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
      this.ui.focusComposer(first.id);
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
    return this.startLane({ fromNodeId, contextMode: 'path', anchorQuote: null, title }, title);
  }

  /**
   * "Ask your own" under a reply: the user's question in a new lane, asked
   * like a followed tangent. Untitled until the first reply names it.
   */
  askFrom(fromNodeId: string, content: string): Promise<Branch | null> {
    return this.startLane({ fromNodeId, contextMode: 'path', anchorQuote: null }, content);
  }

  /** Creates a lane, opens it and sends `content` as its first message. */
  private async startLane(req: CreateBranchRequest, content: string): Promise<Branch | null> {
    const branch = await this.createBranch(req, false);
    if (branch) {
      this.go(branch.id);
      void this.send(branch.id, content);
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

  // Links between messages

  /**
   * Links two messages of the open tree (not a generating call: it stays
   * available on read-only lanes). Two messages already linked, either way
   * round, keep their link.
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
      // Removed elsewhere already (another tab, or Power): the same outcome.
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
    if (this.ui.linkPopover()?.linkId === linkId) this.ui.linkPopover.set(null);
  }

  /** A link the server no longer has (removed elsewhere): drop its line and chips here too. */
  private dropGoneLink(linkId: string): void {
    this.dropLink(linkId);
    this.ui.notify('That link was already removed');
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
    if (this.blockedSends().some((s) => s.branchId === branchId)) {
      this.blockedSends.update((list) => list.filter((s) => s.branchId !== branchId));
    }
    this.setUnsentDraft(branchId, null);
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
            // In the tree now: the lane's box may let the text go.
            this.ui.markSent(branchId, content);
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
        // Refused before anything was written: the text goes back to the lane's box
        // and, for want of the key, waits for the keys dialog to carry it on.
        this.setUnsentDraft(branchId, content);
        if (err instanceof ApiError && err.code === 'key_required') {
          this.blockedSends.update((list) => addBlockedSend(list, { branchId, content }));
        }
      }
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
      // The shell's notice explains it and links to the power app's /billing; own-key
      // lanes turn read-only (the only funding the server asks the membership for), and
      // `me` brings the rest.
      this.membership.update((m) => (m ? { ...m, required: true, status: 'inactive' } : m));
      this.membershipNeededFor.update((f) => (f.includes('own-key') ? f : [...f, 'own-key']));
      this.noticeForced.set(true);
      void this.refreshMe();
      void this.refreshBilling();
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

  private applyLinks(links: NodeLink[]): void {
    this.detail.update((d) => {
      if (!d) return d;
      const mine = links.filter((l) => l.treeId === d.tree.id);
      return mine.length ? { ...d, links: upsertById(d.links, mine) } : d;
    });
  }

  /** Stops following the replies of a deleted tree (the server has no tree to stream them from). */
  private stopTreeStreams(treeId: string): void {
    for (const l of this.live().values()) {
      if (l.treeId !== treeId) continue;
      this.controllers.get(l.nodeId)?.abort();
      this.controllers.delete(l.nodeId);
      this.dropLive(l.nodeId);
    }
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
    if (this.blockedSends().some((s) => branchIds.has(s.branchId))) {
      this.blockedSends.update((list) => list.filter((s) => !branchIds.has(s.branchId)));
    }
    for (const id of branchIds) this.setUnsentDraft(id, null);
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
    this.dropLinkState(branchIds, nodeIds);
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

  /** Linking from a message that is gone, its popover, or a way back to a lane that is. */
  private dropLinkState(branchIds: ReadonlySet<string>, nodeIds: ReadonlySet<string>): void {
    for (const s of [this.ui.linkPick, this.ui.linkDialog, this.ui.linkDrag]) {
      const from = s()?.fromNodeId;
      if (from !== undefined && nodeIds.has(from)) s.set(null);
    }
    const open = this.ui.linkPopover();
    if (open && !this.links().some((l) => l.id === open.linkId)) this.ui.linkPopover.set(null);
    const back = this.ui.linkReturn();
    if (back && (branchIds.has(back.branchId) || branchIds.has(back.toBranchId))) {
      this.ui.linkReturn.set(null);
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
