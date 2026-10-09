import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { linkTarget } from '@tangent/core/links';
import { branchChain, branchLeaf, descendantBranches } from '@tangent/core/tree';
import { providerRouteKey, routeKey, type BranchFunding } from '@tangent/shared';
import type {
  Branch,
  ContextMode,
  ContextPlan,
  CreateBranchRequest,
  ProviderInfo,
  UpdateBranchRequest,
} from '@tangent/shared';
import {
  ApiClient,
  PowerConversationStore,
  errorMessage,
  membershipBlocks,
} from '@tangent/web-shared';
import { laneTitle } from '../canvas/titles';
import { UiStore } from './ui-store';

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
 * The canvas's state: the shared conversation engine and account
 * (`PowerConversationStore`), with what the canvas adds: every lane's
 * lineage, fan-outs, which lanes are busy, and the membership notice. Any
 * number of lanes may generate at once; `busyBranches` tells them apart.
 */
@Injectable({ providedIn: 'root' })
export class CanvasStore extends PowerConversationStore<ApiClient> {
  private readonly ui = inject(UiStore);

  constructor() {
    super(inject(ApiClient), inject(Router), {
      tree: 'conversation',
      branch: 'lane',
      link: 'link',
      linked: { created: 'Messages linked', existing: 'Already linked' },
    });
  }

  // Lineage (one plan per lane, cached by leaf)
  readonly lineages = signal<ReadonlyMap<string, Lineage>>(new Map());
  readonly lineageLoading = signal<string | null>(null);
  private lineageSeq = 0;
  /** `branch|leaf` keys with a request running, so a re-run effect doesn't send another. */
  private readonly lineageInFlight = new Set<string>();
  /** `branch|leaf` keys whose request failed: not retried until the tree or the lane changes. */
  private readonly lineageFailed = new Set<string>();

  readonly chainIds = computed<ReadonlySet<string>>(() => new Set(this.chain().map((b) => b.id)));

  /** The server refused an own-key call for want of a membership (402 `membership_required`). */
  private readonly noticeForced = signal(false);

  /**
   * The shell shows a notice linking to `/billing`: the membership is
   * required and the user has none, and either no credit can carry on or the
   * server just refused an own-key call.
   */
  readonly membershipBlocked = computed(
    () =>
      membershipBlocks(this.account.membership()) &&
      (this.noticeForced() || !this.account.creditCarriesOn()),
  );

  /** The notice may be dismissed: Tangent credit can still pay (it needs no membership). */
  readonly membershipDismissible = computed(() => this.account.creditCarriesOn());

  dismissMembershipNotice(): void {
    this.noticeForced.set(false);
  }

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

  // Routing

  override setRoute(
    treeId: string | null,
    branchId: string | null,
    focusNodeId: string | null,
  ): void {
    super.setRoute(treeId, branchId, focusNodeId);
    const back = this.ui.linkReturn();
    if (back && back.branchId === this.selectedBranchId() && back.nodeId === focusNodeId) {
      // Back where the link was followed from (the pill or the browser's Back).
      this.ui.linkReturn.set(null);
    }
  }

  protected override treeChanged(): void {
    this.ui.clearLinkState();
    this.lineages.set(new Map());
    this.lineageFailed.clear();
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

  /** Branches strictly below `branchId` (what a collapsed lane hides). */
  descendants(branchId: string): Branch[] {
    const idx = this.index();
    return idx ? descendantBranches(idx, branchId) : [];
  }

  // Branches

  async createBranch(req: CreateBranchRequest, open = true): Promise<Branch | null> {
    const branch = await this.addBranch(req);
    if (branch && open) {
      this.go(branch.id);
      this.ui.focusComposer(branch.id);
    }
    return branch;
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
      const title = several
        ? `${modelLabel(this.account.providers(), v, v.model)} · ${v.contextMode}`
        : '';
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
   * already followed from that message just opens its lane. On a locked lane
   * nothing new is opened: the lane would start on its route, read-only.
   */
  async followTangent(fromNodeId: string, title: string): Promise<Branch | null> {
    const existing = this.childBranchesAt(fromNodeId).find((b) => b.title === title);
    if (existing) {
      this.go(existing.id);
      return existing;
    }
    const idx = this.index();
    const from = idx?.nodes.get(fromNodeId);
    const lane = from && idx?.branches.get(from.branchId);
    if (lane && this.account.routeLocked(lane)) return null;
    return this.startBranch({ fromNodeId, contextMode: 'path', anchorQuote: null, title }, title);
  }

  /**
   * "Ask your own" under a reply: the user's question in a new lane, asked
   * like a followed tangent. Untitled until the first reply names it.
   */
  askFrom(fromNodeId: string, content: string): Promise<Branch | null> {
    return this.startBranch({ fromNodeId, contextMode: 'path', anchorQuote: null }, content);
  }

  override async updateBranch(branchId: string, req: UpdateBranchRequest): Promise<boolean> {
    const ok = await super.updateBranch(branchId, req);
    // The plan depends on mode, quote and model: drop the cached one.
    if (ok) this.dropLineage(branchId);
    return ok;
  }

  // Links between messages

  protected override linkDropped(linkId: string): void {
    if (this.ui.linkPopover()?.linkId === linkId) this.ui.linkPopover.set(null);
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

  protected override sent(branchId: string, content: string): void {
    // In the tree now: the lane's box may let the text go.
    this.ui.markSent(branchId, content);
  }

  protected notify(text: string, kind?: 'info' | 'error'): void {
    this.ui.notify(text, kind);
  }

  protected override keysSettled(): void {
    this.ui.keysOpen.set(false);
  }

  protected override movedToCredit(branch: Branch): void {
    this.ui.notify(`“${branch.title}” now uses Tangent credit`);
  }

  fail(err: unknown): void {
    console.error(err);
    const refusal = this.account.absorb(err);
    if (refusal === 'membership_required') {
      // The shell's notice explains it and links to the power app's /billing.
      this.noticeForced.set(true);
      return;
    }
    if (refusal === 'payment_required') {
      // Out of Tangent credit (the only metered provider here).
      this.ui.notify(errorMessage(err), 'error', { label: 'Add credit', href: '/billing' });
      return;
    }
    this.ui.notify(errorMessage(err), 'error');
    if (refusal === 'key_required') this.ui.keysOpen.set(true);
  }

  // Internals

  protected override branchesRemoved(
    branchIds: ReadonlySet<string>,
    nodeIds: ReadonlySet<string>,
  ): void {
    super.branchesRemoved(branchIds, nodeIds);
    for (const id of branchIds) this.dropLineage(id);
    this.dropLinkState(branchIds, nodeIds);
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
