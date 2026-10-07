import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
// The tree helpers only: the rest of @tangent/core (the ChatService) is for the lazy demo chunk.
import { indexLinks, linkTarget } from '@tangent/core/links';
import { branchChain, branchPath, indexTree, type TreeIndex } from '@tangent/core/tree';
import {
  checkSourcesMessage,
  BUILT_IN_PROVIDER_ID,
  POOL_NOTICE_VERSION,
  type Branch,
  type ChatNode,
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
  backupFile,
  errorMessage,
  isMembershipRequired,
  isNotFound,
  isPaymentRequired,
  isPoolConsentRequired,
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

/** A message the server refused to take (e.g. out of credit), offered back to the composer. */
export interface UnsentDraft {
  branchId: string;
  text: string;
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
 * Learn's endpoint, the built-in provider (`openrouter`; PLAN §2.2); the first
 * provider otherwise. Learn pays per request (its payment header), never per
 * branch, so it names no funding.
 */
const LEARN_PROVIDER_ID = BUILT_IN_PROVIDER_ID;

export const OUT_OF_CREDIT_MESSAGE = 'Add credit to keep learning';
/** The pool notice changed since this page loaded: its copy of the text is stale. */
export const STALE_POOL_NOTICE_MESSAGE =
  'The open pool notice has changed. Reload the page to read the new one.';

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

  // Providers (simple accounts: one provider with "Smart" and "Simple" models)
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
  /** Branch whose POST is in flight (before `start` arrives). */
  readonly sendingBranchId = signal<string | null>(null);
  readonly unsentDraft = signal<UnsentDraft | null>(null);
  readonly poolBlock = signal<LessonPoolBlock | null>(null);
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
    const sending = this.sendingBranchId();
    return (
      this.streamingNode() !== null || (sending !== null && sending === this.selectedBranchId())
    );
  });

  // Loading

  async init(): Promise<void> {
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
      this.trees.set(await this.api.listTrees());
    } catch (err) {
      this.fail(err);
    } finally {
      this.treesLoaded.set(true);
    }
  }

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
          ? 'This lesson does not exist.'
          : errorMessage(err),
      );
    } finally {
      if (seq === this.detailSeq) this.detailLoading.set(false);
    }
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
      else {
        this.detail.set(null);
        this.detailError.set(null);
      }
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
      this.detail.set(detail);
      this.selectedTreeId.set(detail.tree.id);
      this.trees.update((list) => [summaryOf(detail), ...list]);
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
      this.trees.update((list) => list.filter((t) => t.id !== treeId));
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
      this.trees.update((list) => [summaryOf(detail), ...list]);
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
   * web search. On the branch's last reply the check is appended there; on an
   * earlier one it opens a side question, so later messages keep their place.
   */
  async checkSources(nodeId: string): Promise<boolean> {
    const idx = this.index();
    const node = idx?.nodes.get(nodeId);
    if (!idx || !node || node.role !== 'assistant') return false;
    const parent = node.parentId ? idx.nodes.get(node.parentId) : undefined;
    const content = checkSourcesMessage(parent?.role === 'user' ? parent.content : null);
    const own = idx.nodesByBranch.get(node.branchId) ?? [];
    if (own.at(-1)?.id === node.id) {
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

  /** The Smart/Simple toggle. */
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
    this.sendingBranchId.set(branchId);
    if (this.unsentDraft()?.branchId === branchId) this.unsentDraft.set(null);
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
      const block = poolBlockOf(err);
      if (block) {
        // The pool's empty and cap-reached states: inline, never a toast or a navigation.
        this.unsentDraft.set({ branchId, text: content });
        this.poolBlock.set({ ...block, branchId });
        void this.account.refreshPool();
        return false;
      }
      if (
        isPaymentRequired(err) ||
        isMembershipRequired(err) ||
        isPoolUnavailable(err) ||
        isPoolConsentRequired(err) ||
        (err instanceof ApiError && err.code === 'key_required')
      ) {
        this.unsentDraft.set({ branchId, text: content });
      }
      this.fail(err);
      return false;
    } finally {
      if (this.sendingBranchId() === branchId) this.sendingBranchId.set(null);
      if (nodeId) this.controllers.delete(nodeId);
    }
  }

  dismissPoolBlock(): void {
    this.poolBlock.set(null);
  }

  /**
   * The pool notice was acknowledged (PoolFirstUseDialog): records it at the
   * version of the text this build shows (`POOL_NOTICE_VERSION`, never the
   * version the server asked for), then sends the message the pool refused for
   * want of it, if any. False when it couldn't be recorded (the dialog stays
   * open). When the server asked for another version, or answers 409, the
   * notice changed since this page loaded, so this copy of its text is stale.
   */
  async acknowledgePoolNotice(): Promise<boolean> {
    const asked = this.ui.poolConsentVersion();
    if (asked !== null && asked !== POOL_NOTICE_VERSION) {
      this.ui.notify(STALE_POOL_NOTICE_MESSAGE, 'error');
      return false;
    }
    try {
      await this.api.poolConsent(POOL_NOTICE_VERSION);
    } catch (err) {
      this.ui.notify(
        err instanceof ApiError && err.code === 'conflict'
          ? STALE_POOL_NOTICE_MESSAGE
          : errorMessage(err),
        'error',
      );
      return false;
    }
    this.ui.poolConsentVersion.set(null);
    void this.account.refreshPool();
    const draft = this.unsentDraft();
    if (draft) void this.send(draft.branchId, draft.text);
    return true;
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
   * opens the check; one that hasn't acknowledged the current pool notice
   * (403 pool_consent_required) opens the notice.
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
    if (isPoolConsentRequired(err)) {
      this.ui.poolConsentVersion.set(err.consent?.currentVersion ?? POOL_NOTICE_VERSION);
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
    void this.account.refreshBalance();
    if (this.account.payment.poolAvailable()) void this.account.refreshPool();
    void this.refreshAfterCompletion();
  }

  /** Lessons are titled after the first reply: refresh the list and the open lesson's title. */
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

  private applyLink(link: NodeLink): void {
    this.detail.update((d) =>
      d && d.tree.id === link.treeId ? { ...d, links: upsertById(d.links, [link]) } : d,
    );
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
    if (draft && branchIds.has(draft.branchId)) this.unsentDraft.set(null);
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
