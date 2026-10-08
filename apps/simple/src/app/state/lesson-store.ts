import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
// The tree helpers only: the rest of @tangent/core (the ChatService) is for the lazy demo chunk.
import { indexLinks, linkTarget } from '@tangent/core/links';
import { branchChain, branchPath, indexTree, type TreeIndex } from '@tangent/core/tree';
import {
  checkSourcesMessage,
  BUILT_IN_PROVIDER_ID,
  TIER_LABELS,
  tierModel,
  type Branch,
  type ChatNode,
  type CommitCandidateResponse,
  type DeleteBranchResponse,
  type ModelInfo,
  type NodeLink,
  type ProviderInfo,
  type StreamEvent,
  type TreeBackupInput,
  type TreeDetail,
  type TreeSummary,
} from '@tangent/shared';
import {
  ApiClient,
  ApiError,
  coalesced,
  backupFile,
  CompareRun,
  errorMessage,
  isMembershipRequired,
  isNotFound,
  isPaymentRequired,
  isPoolUnavailable,
  poolBlockOf,
  readBackupFile,
  runStream,
  SAVE_FILE,
  type BackupFile,
  type PoolBlock,
  type StreamOutcome,
} from '@tangent/web-shared';
import { lessonTitle } from '../chat/titles';
import { AccountStore } from './account-store';
import { UiStore } from './ui-store';

/** Live state of a reply, kept apart from `detail` so deltas don't re-index the tree. */
export interface LiveReply {
  nodeId: string;
  treeId: string;
  branchId: string;
  content: string;
  /** Latest `status` event (e.g. "Summarizing…"). */
  status: string | null;
  reconnecting: boolean;
}

/**
 * A message that didn't reach the lesson (refused, e.g. out of credit or for
 * want of the own key, or a failed request), offered back to the composer
 * of its branch. Kept for the tab and its user (`UNSENT_STORAGE_KEY`):
 * a top-up (checkout) and the human check leave the page and come back to it.
 */
export interface UnsentDraft {
  treeId: string;
  branchId: string;
  text: string;
  /** Sent as a "Check sources" request: resent as one, never offered as typed text. */
  ground?: 'required';
  /**
   * Refused for want of the learner's own key (401 `key_required`): once
   * "How replies are paid for" is settled (a key saved, credit or the pool
   * picked), it is sent (`resumeUnsent`).
   */
  needsKey?: boolean;
}

/** Where the unsent message waits in sessionStorage (this tab only, like the page it left). */
const UNSENT_STORAGE_KEY = 'tangent.learn.unsent';

/** The message `userId` left unsent in this tab; one left by anyone else is dropped. */
function storedDraft(userId: string): UnsentDraft | null {
  try {
    const raw = sessionStorage.getItem(UNSENT_STORAGE_KEY);
    const d: unknown = raw ? JSON.parse(raw) : null;
    if (typeof d !== 'object' || d === null) return null;
    const { owner, treeId, branchId, text, ground, needsKey } = d as Record<string, unknown>;
    if (owner !== userId) {
      storeDraft(null, null);
      return null;
    }
    if (typeof treeId !== 'string' || typeof branchId !== 'string' || typeof text !== 'string')
      return null;
    return {
      treeId,
      branchId,
      text,
      ...(ground === 'required' ? { ground } : {}),
      ...(needsKey === true ? { needsKey } : {}),
    };
  } catch {
    return null;
  }
}

/** Keeps `d` for the tab as `owner`'s (no one signed in: for this page only). */
function storeDraft(d: UnsentDraft | null, owner: string | null): void {
  try {
    if (d && owner) sessionStorage.setItem(UNSENT_STORAGE_KEY, JSON.stringify({ ...d, owner }));
    else sessionStorage.removeItem(UNSENT_STORAGE_KEY);
  } catch {
    // Storage unavailable: the message waits for this page only.
  }
}

/**
 * A message the open pool refused (402 `pool_empty`, 429
 * `pool_cap_reached`), shown inline in its branch above the composer.
 */
export interface LessonPoolBlock extends PoolBlock {
  branchId: string;
}

/**
 * Where a connection was followed from (`openNode`): the branch and the
 * message whose chip was clicked, offered back as "Back to …" while the
 * lesson stays on the branch the connection went to (`toBranchId`).
 */
export interface LinkReturn {
  branchId: string;
  nodeId: string;
  toBranchId: string;
  toNodeId: string;
}

/**
 * Learn's endpoint, the built-in provider (`openrouter`); the first
 * provider otherwise. Learn pays per request (its payment header), never per
 * branch, so it names no funding.
 */
const LEARN_PROVIDER_ID = BUILT_IN_PROVIDER_ID;

export const OUT_OF_CREDIT_MESSAGE = 'Add credit to keep learning';
/** A Compare pick the server no longer accepts (409 the lesson moved on, 410 expired). */
export const COMPARE_OUT_OF_DATE_MESSAGE =
  'That comparison is out of date. Your question is still in the box.';
/**
 * Refusals that end a Compare outright, as they would a send: no key (401),
 * no credit or membership (402), the pool's checks (403).
 */
export const COMPARE_BLOCKING_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);
/** Commit refusals that mean the comparison no longer fits the lesson (gone, moved on, expired). */
const COMPARE_GONE_STATUSES: ReadonlySet<number> = new Set([404, 409, 410]);
/**
 * How a Compare pick ended (`commitCompare`): only `failed` leaves the
 * answers worth keeping on screen, for another try.
 */
export type CompareCommitOutcome = 'kept' | 'out-of-date' | 'refused' | 'failed';

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
 * Learner state: lessons (trees), the open lesson, the selected branch, and
 * live replies. Streaming, reconnect and cancel follow the power app's
 * TreeStore: `runStream` reconnects through `GET /api/nodes/:id/stream`, Stop
 * asks the server to cancel (the stream then ends with an `error` event),
 * and replies still running when a lesson is opened are re-attached.
 * A 402 `payment_required` (out of credit) sends the learner to the billing
 * page; a 402 `membership_required` locks the own key (`KeyLockedNotice`). The open
 * pool's refusals are states, not errors: empty (402 `pool_empty`) and cap
 * reached (429 `pool_cap_reached`) show inline in the chat (`poolBlock`),
 * and a first pool message without a human check on record opens the check.
 * All of them arrive before the message is written, so it is kept.
 */
@Injectable({ providedIn: 'root' })
export class LessonStore {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly ui = inject(UiStore);
  private readonly account = inject(AccountStore);
  private readonly saveFile = inject(SAVE_FILE);

  // Providers (Learn accounts: one provider with a Normal and a Max model, `ModelInfo.tier`)
  readonly providers = signal<ProviderInfo[]>([]);
  readonly provider = computed<ProviderInfo | null>(
    () => this.providers().find((p) => p.id === LEARN_PROVIDER_ID) ?? this.providers()[0] ?? null,
  );
  readonly models = computed<readonly ModelInfo[]>(() => this.provider()?.models ?? []);
  readonly defaultModel = computed<string | null>(() => this.provider()?.defaultModel ?? null);

  // Lessons
  readonly trees = signal<TreeSummary[]>([]);
  readonly treesLoaded = signal(false);
  /** The lesson whose backup is being downloaded (Export). */
  readonly exportingId = signal<string | null>(null);
  readonly importing = signal(false);

  // The open lesson
  readonly selectedTreeId = signal<string | null>(null);
  readonly detail = signal<TreeDetail | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);
  private readonly routeBranchId = signal<string | null>(null);
  /** Message to scroll to (e.g. the branch point after going back to the parent). */
  readonly focusedNodeId = signal<string | null>(null);
  /** Where the latest followed connection came from ("Back to …"); cleared on the way back. */
  readonly linkReturn = signal<LinkReturn | null>(null);

  // Replies
  readonly live = signal<ReadonlyMap<string, LiveReply>>(new Map());
  /** Branches whose POST is in flight (before `start` arrives). */
  readonly sending = signal<ReadonlySet<string>>(new Set());
  readonly unsentDraft = signal<UnsentDraft | null>(null);
  /** The text the open branch's composer takes back: only what the learner typed. */
  readonly composerDraft = computed(() => {
    const d = this.unsentDraft();
    return d && !d.ground && d.branchId === this.selectedBranchId() ? d.text : '';
  });
  readonly poolBlock = signal<LessonPoolBlock | null>(null);
  /** The Compare sheet is open (its answers stream): the composer waits. */
  readonly comparing = signal(false);
  private readonly controllers = new Map<string, AbortController>();
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

  /** The open lesson's connections between messages (NodeLink). */
  readonly links = computed<readonly NodeLink[]>(() => this.detail()?.links ?? []);
  /** Connections by message, each under both of its ends. */
  readonly linksByNode = computed(() => indexLinks(this.links()));

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

  /** The reply currently generating in the selected branch. */
  readonly streamingNode = computed<ChatNode | null>(() => {
    const id = this.selectedBranchId();
    const idx = this.index();
    if (!id || !idx) return null;
    return (idx.nodesByBranch.get(id) ?? []).find((n) => n.status === 'streaming') ?? null;
  });

  readonly busy = computed(() => {
    const id = this.selectedBranchId();
    return (
      this.comparing() || this.streamingNode() !== null || (id !== null && this.sending().has(id))
    );
  });

  // Loading

  /** After `AccountStore.setMe`: whose message left unsent in this tab is offered back. */
  async init(): Promise<void> {
    const userId = this.account.me()?.userId;
    if (userId && !this.unsentDraft()) this.unsentDraft.set(storedDraft(userId));
    await Promise.all([this.loadProviders(), this.loadTrees()]);
  }

  async loadProviders(): Promise<void> {
    try {
      this.providers.set(await this.api.providers());
    } catch (err) {
      this.fail(err);
    }
  }

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
  private editTrees(change: (list: TreeSummary[]) => TreeSummary[]): void {
    this.treesSeq++;
    this.trees.update(change);
  }

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
          ? 'This lesson does not exist.'
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

  // Routing (the URL is the source of truth for the selection)

  /** Called after every navigation (RouteSync). */
  setRoute(treeId: string | null, branchId: string | null, focusNodeId: string | null): void {
    this.routeBranchId.set(branchId);
    this.focusedNodeId.set(focusNodeId);
    const back = this.linkReturn();
    const branch = this.selectedBranchId();
    if (
      back &&
      // Back where the connection was followed from (the pill or the browser's
      // Back, which usually lands on a URL without `?m=`), or anywhere else.
      ((back.nodeId === focusNodeId && back.branchId === branch) || back.toBranchId !== branch)
    ) {
      this.linkReturn.set(null);
    }
    if (treeId !== this.selectedTreeId()) {
      this.linkReturn.set(null);
      this.selectedTreeId.set(treeId);
      if (treeId) void this.loadTree(treeId);
      else this.showDetail(null);
    }
  }

  go(branchId: string, focusNodeId: string | null = null, replace = false): void {
    const treeId = this.selectedTreeId();
    if (!treeId) return;
    const trunk = this.index()?.trunk.id;
    const commands = branchId === trunk ? ['/t', treeId] : ['/t', treeId, 'b', branchId];
    void this.router.navigate(commands, {
      queryParams: focusNodeId ? { m: focusNodeId } : {},
      ...(replace ? { replaceUrl: true } : {}),
    });
  }

  /** Back to the parent branch, at the message the side question started from. */
  goToParent(): void {
    const b = this.selectedBranch();
    if (b?.parentBranchId) this.go(b.parentBranchId, b.branchPointNodeId);
  }

  /**
   * Follows a connection to `nodeId` (its branch, focused on it). With
   * `fromNodeId`, the message the chip was under is offered back ("Back to …").
   */
  openNode(nodeId: string, fromNodeId: string | null = null): void {
    const idx = this.index();
    const target = idx && linkTarget(idx, nodeId);
    if (!target) return;
    const from = fromNodeId ? idx.nodes.get(fromNodeId) : undefined;
    this.linkReturn.set(
      from
        ? {
            branchId: this.selectedBranchId() ?? from.branchId,
            nodeId: from.id,
            toBranchId: target.branchId,
            toNodeId: nodeId,
          }
        : null,
    );
    this.go(target.branchId, target.focusNodeId);
  }

  /** "Back to …": returns to where the latest connection was followed from. */
  goBackFromLink(): void {
    const back = this.linkReturn();
    if (!back) return;
    this.linkReturn.set(null);
    this.go(back.branchId, back.nodeId);
  }

  childBranchesAt(nodeId: string): readonly Branch[] {
    return this.index()?.branchesAtNode.get(nodeId) ?? [];
  }

  // Lessons

  /** Creates a lesson, opens it, and sends `topic` as the first message when there is one. */
  async startLesson(model: string | null, topic: string): Promise<boolean> {
    const providerId = this.provider()?.id;
    try {
      const detail = await this.api.createTree({
        ...(providerId ? { providerId } : {}),
        ...(model ? { model } : {}),
      });
      this.showDetail(detail);
      this.selectedTreeId.set(detail.tree.id);
      this.editTrees((list) => [summaryOf(detail), ...list]);
      await this.router.navigate(['/t', detail.tree.id]);
      const first = topic.trim();
      if (first) void this.send(detail.tree.trunkBranchId, first);
      else this.ui.focusComposer();
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /** Deletes a lesson; the caller confirms first. */
  async deleteLesson(treeId: string): Promise<boolean> {
    try {
      await this.api.deleteTree(treeId);
      this.stopTreeStreams(treeId);
      if (this.unsentDraft()?.treeId === treeId) this.setUnsent(null);
      this.editTrees((list) => list.filter((t) => t.id !== treeId));
      if (this.selectedTreeId() === treeId) await this.router.navigate(['/']);
      this.ui.notify('Lesson deleted');
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /**
   * Export: downloads the lesson's JSON backup, the same file as power
   * mode's, so it can be imported into either app. Fetched with Learn's
   * headers (a plain link would ask the power account) and saved from memory.
   */
  async exportLesson(treeId: string): Promise<boolean> {
    if (this.exportingId()) return false;
    this.exportingId.set(treeId);
    try {
      const { name, blob } = backupFile(await this.api.backup(treeId));
      this.saveFile(name, blob);
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    } finally {
      this.exportingId.set(null);
    }
  }

  /**
   * Import: reads a JSON backup (from either app), imports it into this Learn
   * account and opens it. The server adapts a power conversation to Learn
   * (its provider and models, the tutor prompt, side questions in context).
   * A file that isn't a usable backup is refused before anything is sent.
   */
  async importLesson(file: BackupFile): Promise<boolean> {
    if (this.importing()) return false;
    this.importing.set(true);
    try {
      let backup: TreeBackupInput;
      try {
        backup = await readBackupFile(file);
      } catch (err) {
        this.ui.notify(errorMessage(err), 'error');
        return false;
      }
      const detail = await this.api.importBackup(backup);
      this.editTrees((list) => [summaryOf(detail), ...list]);
      this.ui.notify(`Imported “${lessonTitle(detail.tree.title)}”`);
      await this.router.navigate(['/t', detail.tree.id]);
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    } finally {
      this.importing.set(false);
    }
  }

  // Branches

  /**
   * "Ask about this": a side question from `fromNodeId`, quoting `quote`,
   * with the full path as context and the current branch's model.
   */
  async askAbout(fromNodeId: string, quote: string | null): Promise<Branch | null> {
    const current = this.selectedBranch();
    try {
      const branch = await this.api.createBranch({
        fromNodeId,
        contextMode: 'path',
        anchorQuote: quote,
        ...(current ? { providerId: current.providerId, model: current.model } : {}),
      });
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
   * Follows one of the tutor's suggested tangents: a side question from
   * `fromNodeId` titled after the tangent, whose first message is the
   * tangent's title. Clicking the same tangent again goes to its branch.
   */
  async followTangent(fromNodeId: string, title: string): Promise<Branch | null> {
    const existing = this.childBranchesAt(fromNodeId).find((b) => b.title === title);
    if (existing) {
      this.go(existing.id);
      return existing;
    }
    return this.startSideQuestion(fromNodeId, title, title);
  }

  /**
   * "Ask your own" under a reply: the learner's question as a side question,
   * asked like a followed tangent. Untitled until the first reply names it.
   */
  askFrom(fromNodeId: string, content: string): Promise<Branch | null> {
    return this.startSideQuestion(fromNodeId, null, content);
  }

  /** A side question from `fromNodeId` on the current model, opened, with `content` sent first. */
  private async startSideQuestion(
    fromNodeId: string,
    title: string | null,
    content: string,
  ): Promise<Branch | null> {
    const current = this.selectedBranch();
    try {
      const branch = await this.api.createBranch({
        fromNodeId,
        contextMode: 'path',
        anchorQuote: null,
        ...(title ? { title } : {}),
        ...(current ? { providerId: current.providerId, model: current.model } : {}),
      });
      this.applyBranch(branch);
      this.go(branch.id);
      void this.send(branch.id, content);
      return branch;
    } catch (err) {
      this.fail(err);
      return null;
    }
  }

  /**
   * Deletes a side question with every side question below it; the caller
   * confirms first. Replies still generating there are stopped. When the
   * open side question goes, the lesson moves to the message it started from.
   */
  async deleteSideQuestion(branchId: string): Promise<boolean> {
    const doomed = this.index()?.branches.get(branchId);
    if (!doomed?.parentBranchId) return false;
    try {
      const res = await this.api.deleteBranch(branchId);
      const selected = this.selectedBranchId();
      if (selected && res.branchIds.includes(selected)) {
        this.go(doomed.parentBranchId, doomed.branchPointNodeId, true);
      }
      this.removeBranches(res);
      this.ui.notify(
        res.branchIds.length > 1
          ? `Deleted the side question and ${res.branchIds.length - 1} below it`
          : 'Side question deleted',
      );
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /** Depth of a branch: 0 for the main thread, 1 for a side question of it, … */
  depthOf(branchId: string): number {
    const idx = this.index();
    return idx ? Math.max(0, branchChain(idx, branchId).length - 1) : 0;
  }

  /** Whether replies in `branchId` can be checked against web sources (not on the pool). */
  canCheckSources(branchId: string): boolean {
    const branch = this.index()?.branches.get(branchId);
    // The open pool can't pay for searches (its holds are priced from tokens alone).
    if (!branch || this.account.payment.payment() === 'pool') return false;
    return this.providers().find((p) => p.id === branch.providerId)?.webSearch === true;
  }

  /**
   * "Check sources" on a finished reply: asks the tutor to check it with a
   * web search. On the open branch's last reply the check is appended there;
   * on an earlier one, including one of an ancestor branch (the open branch's
   * messages follow it on screen), it opens a side question, so later
   * messages keep their place and the check streams where the learner sees it.
   */
  async checkSources(nodeId: string): Promise<boolean> {
    const idx = this.index();
    const node = idx?.nodes.get(nodeId);
    if (!idx || !node || node.role !== 'assistant') return false;
    const parent = node.parentId ? idx.nodes.get(node.parentId) : undefined;
    const content = checkSourcesMessage(parent?.role === 'user' ? parent.content : null);
    if (node.branchId === this.selectedBranchId() && this.path().at(-1)?.id === node.id) {
      return this.send(node.branchId, content, { ground: 'required' });
    }
    const from = idx.branches.get(node.branchId);
    try {
      const branch = await this.api.createBranch({
        fromNodeId: node.id,
        contextMode: 'path',
        anchorQuote: null,
        title: 'Checking sources',
        ...(from ? { providerId: from.providerId, model: from.model } : {}),
      });
      this.applyBranch(branch);
      this.go(branch.id);
      return await this.send(branch.id, content, { ground: 'required' });
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /** The Normal/Max toggle. */
  async setModel(branchId: string, model: string): Promise<boolean> {
    const before = this.index()?.branches.get(branchId);
    if (before?.model === model) return true;
    try {
      this.applyBranch(await this.api.updateBranch(branchId, { model }));
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  // Connections (links between messages)

  /**
   * Connects two messages of the open lesson, with an optional note. Asking
   * for a pair that is already connected (either way round) answers with the
   * existing connection.
   */
  async createLink(
    fromNodeId: string,
    toNodeId: string,
    note: string | null,
  ): Promise<NodeLink | null> {
    try {
      const { link, created } = await this.api.createLink({ fromNodeId, toNodeId, note });
      this.applyLink(link);
      this.ui.notify(created ? 'Connected' : 'Already connected');
      return link;
    } catch (err) {
      this.fail(err);
      return null;
    }
  }

  /** Changes a connection's note (null clears it). */
  async updateLink(linkId: string, note: string | null): Promise<boolean> {
    try {
      this.applyLink(await this.api.updateLink(linkId, { note }));
      this.ui.notify('Note saved');
      return true;
    } catch (err) {
      if (isNotFound(err)) this.dropGoneLink(linkId);
      else this.fail(err);
      return false;
    }
  }

  /** Removes a connection; the caller confirms first. */
  async deleteLink(linkId: string): Promise<boolean> {
    try {
      await this.api.deleteLink(linkId);
      this.dropLink(linkId);
      this.ui.notify('Connection removed');
      return true;
    } catch (err) {
      // Removed elsewhere already (another tab): the same outcome.
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

  /** A connection the server no longer has (removed elsewhere): drop it here too. */
  private dropGoneLink(linkId: string): void {
    this.dropLink(linkId);
    this.ui.notify('That connection was already removed');
  }

  // Messages and replies

  async send(
    branchId: string,
    content: string,
    options: { ground?: 'required' } = {},
  ): Promise<boolean> {
    this.markSending(branchId, true);
    // Sent again: let it go. A "Check sources" request leaves the learner's own message be.
    const draft = this.unsentDraft();
    if (draft?.branchId === branchId && !draft.ground === !options.ground) this.setUnsent(null);
    if (this.poolBlock()?.branchId === branchId) this.poolBlock.set(null);
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
            this.markSending(branchId, false);
            // In the lesson now: the composer may let the text go.
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
      const block = poolBlockOf(err);
      if (block) {
        // The pool's empty and cap-reached states: inline, never a toast or a navigation.
        // A "Check sources" request isn't text the learner typed: not offered back.
        if (!options.ground) this.keepUnsent(branchId, content, options);
        this.poolBlock.set({ ...block, branchId });
        void this.account.refreshPool();
        return false;
      }
      const needsKey = err instanceof ApiError && err.code === 'key_required';
      if (nodeId === null && (!options.ground || needsKey)) {
        // Any refusal or failure before the reply started (out of credit, no key or
        // membership, the pool's checks, a network error…): nothing was written, so
        // the text goes back to the composer. "Check sources" asks no typed text: it
        // is kept only to be resumed once the key is settled.
        this.keepUnsent(branchId, content, options, needsKey);
      }
      this.fail(err);
      return false;
    } finally {
      this.markSending(branchId, false);
      if (nodeId) this.controllers.delete(nodeId);
    }
  }

  // Compare (Normal and Max answer the same question; one is kept)

  /**
   * A Compare of `content` in `branchId`: Normal, then Max (CompareRun
   * staggers them). Null unless the provider lists both tiers.
   */
  newCompare(branchId: string, content: string): CompareRun | null {
    const models = this.models();
    const normal = tierModel(models, 'normal');
    const max = tierModel(models, 'max');
    if (!normal || !max) return null;
    return new CompareRun(this.api, branchId, content, [
      { id: 'normal', label: TIER_LABELS.normal, request: { content, model: normal.id } },
      { id: 'max', label: TIER_LABELS.max, request: { content, model: max.id } },
    ]);
  }

  /**
   * Keeps answer `id` of a Compare: the question and that answer join the
   * lesson as if sent (the branch keeps its own model), the composer lets the
   * question go, and the lesson list is refreshed (a first reply titles it).
   * A comparison the server no longer takes (404, 409, 410) says so and
   * keeps the question (`out-of-date`); a refusal a send would also get (401,
   * 402, 403) is reported like a send's (`refused`); anything else (a network
   * failure, a 5xx, a 429) is reported and `failed`: both answers are still
   * held, so the pick can be tried again.
   */
  async commitCompare(run: CompareRun, id: string): Promise<CompareCommitOutcome> {
    let res: CommitCandidateResponse;
    try {
      res = await run.commit(id);
    } catch (err) {
      if (err instanceof ApiError && COMPARE_GONE_STATUSES.has(err.status)) {
        this.ui.notify(COMPARE_OUT_OF_DATE_MESSAGE, 'error');
        return 'out-of-date';
      }
      this.fail(err);
      return err instanceof ApiError && COMPARE_BLOCKING_STATUSES.has(err.status)
        ? 'refused'
        : 'failed';
    }
    const { userNode, assistantNode, branch } = res;
    this.apply({ type: 'start', userNode, assistantNode, branch }, null);
    this.apply({ type: 'done', node: assistantNode, branch }, assistantNode.id);
    if (this.unsentDraft()?.branchId === run.branchId) this.setUnsent(null);
    if (this.poolBlock()?.branchId === run.branchId) this.poolBlock.set(null);
    this.ui.markSent(run.question);
    this.finish(assistantNode.id, { kind: 'done' });
    return 'kept';
  }

  /** A Compare refused before any answer (no credit, no key, the pool…): reported like a send's. */
  compareRefused(err: ApiError): void {
    this.fail(err);
  }

  dismissPoolBlock(): void {
    this.poolBlock.set(null);
  }

  /**
   * "How replies are paid for" was settled (a key saved, credit or the pool
   * picked) while a message refused for want of the own key waits
   * (`UnsentDraft.needsKey`): sends it. False when none waits.
   */
  resumeUnsent(): boolean {
    const draft = this.openDraft();
    if (!draft?.needsKey) return false;
    void this.resend(draft);
    return true;
  }

  /** The unsent message of the open lesson, if any (one of another lesson waits for it). */
  private openDraft(): UnsentDraft | null {
    const d = this.unsentDraft();
    return d && d.treeId === this.selectedTreeId() ? d : null;
  }

  /** Sends an unsent message again, as it was first sent. */
  private resend(d: UnsentDraft): Promise<boolean> {
    return this.send(d.branchId, d.text, d.ground ? { ground: d.ground } : {});
  }

  private keepUnsent(
    branchId: string,
    text: string,
    options: { ground?: 'required' },
    needsKey = false,
  ): void {
    const treeId = this.index()?.branches.get(branchId)?.treeId ?? this.selectedTreeId();
    if (!treeId) return;
    // A "Check sources" request never takes the place of a message the learner typed.
    const typed = this.unsentDraft();
    if (options.ground && typed && !typed.ground) return;
    this.setUnsent({ treeId, branchId, text, ...options, ...(needsKey ? { needsKey } : {}) });
  }

  /** Signing out: the message left unsent isn't the next person's to see. */
  forgetUnsent(): void {
    this.setUnsent(null);
  }

  private setUnsent(d: UnsentDraft | null): void {
    this.unsentDraft.set(d);
    storeDraft(d, this.account.me()?.userId ?? null);
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
   * Reports an error. No membership (402 membership_required) locks the own
   * key (the composer gives way to `KeyLockedNotice`, the message is kept);
   * out of credit (402 payment_required) goes to the billing page; a missing
   * or unreadable own key (401 key_required) opens the payment dialog; a pool
   * account without a human check on record (403 pool_unavailable, `verify`)
   * opens the check.
   */
  fail(err: unknown): void {
    if (isMembershipRequired(err)) {
      this.account.membershipRequired();
      return;
    }
    if (isPoolUnavailable(err) && err.pool?.reason === 'verify') {
      this.ui.poolVerifyOpen.set(true);
      return;
    }
    if (err instanceof ApiError && err.code === 'key_required') {
      this.ui.notify(err.message, 'error');
      void this.account.refreshKey();
      this.ui.accessOpen.set(true);
      return;
    }
    if (isPaymentRequired(err)) {
      this.ui.notify(OUT_OF_CREDIT_MESSAGE, 'error');
      void this.account.refreshBalance();
      void this.router.navigate(['/billing']);
      return;
    }
    console.error(err);
    this.ui.notify(errorMessage(err), 'error');
  }

  /** After loading a lesson: re-attach to replies still generating server-side. */
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
        // Unblock the composer; the server answers a racing send with 409 if it is still generating.
        this.markError(nodeId, 'Connection lost. Reload to see the final reply.');
        this.dropLive(nodeId);
      }
    }
    void this.refreshAfterCompletion();
  }

  /**
   * After a reply: the balance, the pool meter while the pool is offered, and
   * the lessons, titled after the first reply (the list and the open
   * lesson's title). Replies finishing together share one refresh, plus one
   * more if asked meanwhile. Quiet on failure: the next reply refreshes again.
   */
  private readonly refreshAfterCompletion = coalesced(async () => {
    const lessons = this.readTrees().then(
      () => true,
      (err: unknown) => {
        console.warn('lesson list refresh failed', err);
        return false;
      },
    );
    const [listed] = await Promise.all([
      lessons,
      this.account.refreshBalance(),
      this.account.payment.poolAvailable() ? this.account.refreshPool() : null,
    ]);
    if (!listed) return;
    const d = this.detail();
    const summary = d && this.trees().find((t) => t.id === d.tree.id);
    if (d && summary && summary.title !== d.tree.title) {
      this.detail.update((cur) =>
        cur ? { ...cur, tree: { ...cur.tree, title: summary.title } } : cur,
      );
    }
  });

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

  private applyLink(link: NodeLink): void {
    this.detail.update((d) =>
      d && d.tree.id === link.treeId ? { ...d, links: upsertById(d.links, [link]) } : d,
    );
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

  /** Drops deleted branches and their messages, and stops following their replies. */
  private removeBranches(res: DeleteBranchResponse): void {
    const branchIds = new Set(res.branchIds);
    const nodeIds = new Set(res.nodeIds);
    for (const id of nodeIds) {
      this.controllers.get(id)?.abort();
      this.controllers.delete(id);
      this.dropLive(id);
    }
    const draft = this.unsentDraft();
    if (draft && branchIds.has(draft.branchId)) this.setUnsent(null);
    const block = this.poolBlock();
    if (block && branchIds.has(block.branchId)) this.poolBlock.set(null);
    this.detail.update((d) =>
      d && d.tree.id === res.treeId
        ? {
            ...d,
            branches: d.branches.filter((b) => !branchIds.has(b.id)),
            nodes: d.nodes.filter((n) => !nodeIds.has(n.id)),
            // The server dropped the connections touching them with them.
            links: d.links.filter(
              (l) => !nodeIds.has(l.sourceNodeId) && !nodeIds.has(l.targetNodeId),
            ),
          }
        : d,
    );
    // Connecting from a message that is gone, or back to a side question that is.
    const from = this.ui.linkDialog();
    if (from !== null && nodeIds.has(from)) this.ui.linkDialog.set(null);
    const back = this.linkReturn();
    if (back && (branchIds.has(back.branchId) || branchIds.has(back.toBranchId))) {
      this.linkReturn.set(null);
    }
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

  private markSending(branchId: string, on: boolean): void {
    if (this.sending().has(branchId) === on) return;
    this.sending.update((set) => {
      const next = new Set(set);
      if (on) next.add(branchId);
      else next.delete(branchId);
      return next;
    });
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
