import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
// The tree helpers only: the rest of @tangent/core (the ChatService) is for the lazy demo chunk.
import { linkTarget } from '@tangent/core/links';
import {
  BUILT_IN_PROVIDER_ID,
  TIER_LABELS,
  tierModel,
  type Branch,
  type CommitCandidateResponse,
  type CreateBranchRequest,
  type ModelInfo,
  type ProviderInfo,
  type TreeBackupInput,
} from '@tangent/shared';
import {
  ApiClient,
  ApiError,
  backupFile,
  CompareRun,
  ComposerController,
  ConversationStore,
  errorMessage,
  isMembershipRequired,
  isPaymentRequired,
  isPoolUnavailable,
  poolBlockOf,
  readBackupFile,
  SAVE_FILE,
  ToastStore,
  type BackupFile,
  type FailedSend,
  type PoolBlock,
  type SendOptions,
} from '@tangent/web-shared';
import { lessonTitle } from '../chat/titles';
import { AccountStore } from './account-store';
import { storedDraft, storeDraft, type UnsentDraft } from './unsent-draft';
import { UiStore } from './ui-store';

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

/**
 * Learner state: the shared conversation engine (`ConversationStore`), with
 * what Learn adds: its one provider and the Normal/Max models, the lesson
 * library (export, import), connections' "Back to …", Compare, and who pays.
 * A 402 `payment_required` (out of credit) sends the learner to the billing
 * page; a 402 `membership_required` locks the own key (`KeyLockedNotice`). The open
 * pool's refusals are states, not errors: empty (402 `pool_empty`) and cap
 * reached (429 `pool_cap_reached`) show inline in the chat (`poolBlock`),
 * and a first pool message without a human check on record opens the check.
 * All of them arrive before the message is written, so it is kept
 * (`unsentDraft`, for the tab and its user).
 */
@Injectable({ providedIn: 'root' })
export class LessonStore extends ConversationStore<ApiClient> {
  private readonly ui = inject(UiStore);
  private readonly composer = inject(ComposerController);
  private readonly toast = inject(ToastStore);
  private readonly account = inject(AccountStore);
  private readonly saveFile = inject(SAVE_FILE);

  constructor() {
    super(inject(ApiClient), inject(Router), {
      tree: 'lesson',
      branch: 'side question',
      link: 'connection',
      linked: { created: 'Connected', existing: 'Already connected' },
      noteSaved: 'Note saved',
    });
  }

  // Providers (Learn accounts: one provider with a Normal and a Max model, `ModelInfo.tier`)
  readonly providers = signal<ProviderInfo[]>([]);
  readonly provider = computed<ProviderInfo | null>(
    () => this.providers().find((p) => p.id === LEARN_PROVIDER_ID) ?? this.providers()[0] ?? null,
  );
  readonly models = computed<readonly ModelInfo[]>(() => this.provider()?.models ?? []);
  readonly defaultModel = computed<string | null>(() => this.provider()?.defaultModel ?? null);
  /** The lesson whose backup is being downloaded (Export). */
  readonly exportingId = signal<string | null>(null);
  readonly importing = signal(false);
  /** Where the latest followed connection came from ("Back to …"); cleared on the way back. */
  readonly linkReturn = signal<LinkReturn | null>(null);
  readonly unsentDraft = signal<UnsentDraft | null>(null);
  /** The text the open branch's composer takes back: only what the learner typed. */
  readonly composerDraft = computed(() => {
    const d = this.unsentDraft();
    return d && !d.ground && d.branchId === this.selectedBranchId() ? d.text : '';
  });
  readonly poolBlock = signal<LessonPoolBlock | null>(null);
  /** The Compare sheet is open (its answers stream): the composer waits. */
  readonly comparing = signal(false);
  override readonly busy = computed(() => {
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

  // Routing

  /** Called after every navigation (RouteSync). */
  override setRoute(
    treeId: string | null,
    branchId: string | null,
    focusNodeId: string | null,
  ): void {
    super.setRoute(treeId, branchId, focusNodeId);
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
  }

  protected override treeChanged(): void {
    this.linkReturn.set(null);
  }

  /** Learn's URLs: the trunk is the lesson's own, focused or not. */
  override go(branchId: string, focusNodeId: string | null = null, replace = false): void {
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

  // Lessons

  /** Creates a lesson, opens it, and sends `topic` as the first message when there is one. */
  async startLesson(model: string | null, topic: string): Promise<boolean> {
    const providerId = this.provider()?.id;
    try {
      const detail = await this.openNewTree({
        ...(providerId ? { providerId } : {}),
        ...(model ? { model } : {}),
      });
      const first = topic.trim();
      if (first) void this.send(detail.tree.trunkBranchId, first);
      else this.composer.focus();
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
        this.toast.notify(errorMessage(err), 'error');
        return false;
      }
      const detail = await this.api.importBackup(backup);
      this.listNewTree(detail);
      this.toast.notify(`Imported “${lessonTitle(detail.tree.title)}”`);
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
    const branch = await this.addBranch({
      fromNodeId,
      contextMode: 'path',
      anchorQuote: quote,
      ...this.newBranchRoute(this.selectedBranch()),
    });
    if (branch) {
      this.go(branch.id);
      this.composer.focus();
    }
    return branch;
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
  private startSideQuestion(
    fromNodeId: string,
    title: string | null,
    content: string,
  ): Promise<Branch | null> {
    return this.startBranch(
      {
        fromNodeId,
        contextMode: 'path',
        anchorQuote: null,
        ...(title ? { title } : {}),
        ...this.newBranchRoute(this.selectedBranch()),
      },
      content,
    );
  }

  /** Side questions keep the model of the branch they come from (Normal or Max). */
  protected override newBranchRoute(from: Branch | null): Partial<CreateBranchRequest> {
    return from ? { providerId: from.providerId, model: from.model } : {};
  }

  /**
   * Deletes a side question with every side question below it; the caller
   * confirms first. Replies still generating there are stopped. When the
   * open side question goes, the lesson moves to the message it started from.
   */
  deleteSideQuestion(branchId: string): Promise<boolean> {
    if (!this.index()?.branches.get(branchId)?.parentBranchId) return Promise.resolve(false);
    return this.deleteBranch(branchId);
  }

  /** Whether replies in `branchId` can be checked against web sources (not on the pool). */
  canCheckSources(branchId: string): boolean {
    const branch = this.index()?.branches.get(branchId);
    // The open pool can't pay for searches (its holds are priced from tokens alone).
    if (!branch || this.account.payment.payment() === 'pool') return false;
    return this.providers().find((p) => p.id === branch.providerId)?.webSearch === true;
  }

  /** The Normal/Max toggle. */
  async setModel(branchId: string, model: string): Promise<boolean> {
    const before = this.index()?.branches.get(branchId);
    if (before?.model === model) return true;
    return this.updateBranch(branchId, { model });
  }

  // Messages and replies

  protected override sendStarting(branchId: string, options: SendOptions): void {
    // Sent again: let it go. A "Check sources" request leaves the learner's own message be.
    const draft = this.unsentDraft();
    if (draft?.branchId === branchId && !draft.ground === !options.ground) this.setUnsent(null);
    if (this.poolBlock()?.branchId === branchId) this.poolBlock.set(null);
  }

  protected override sent(branchId: string, content: string): void {
    this.composer.sent(branchId, content);
  }

  protected override sendFailed(err: unknown, s: FailedSend): void {
    const block = poolBlockOf(err);
    if (block) {
      // The pool's empty and cap-reached states: inline, never a toast or a navigation.
      // A "Check sources" request isn't text the learner typed: not offered back.
      if (!s.options.ground) this.keepUnsent(s.branchId, s.content, s.options);
      this.poolBlock.set({ ...block, branchId: s.branchId });
      void this.account.refreshPool();
      return;
    }
    const needsKey = err instanceof ApiError && err.code === 'key_required';
    if (!s.started && (!s.options.ground || needsKey)) {
      // Any refusal or failure before the reply started (out of credit, no key or
      // membership, the pool's checks, a network error…): nothing was written, so
      // the text goes back to the composer. "Check sources" asks no typed text: it
      // is kept only to be resumed once the key is settled.
      this.keepUnsent(s.branchId, s.content, s.options, needsKey);
    }
    this.fail(err);
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
        this.toast.notify(COMPARE_OUT_OF_DATE_MESSAGE, 'error');
        return 'out-of-date';
      }
      this.fail(err);
      return err instanceof ApiError && COMPARE_BLOCKING_STATUSES.has(err.status)
        ? 'refused'
        : 'failed';
    }
    if (this.unsentDraft()?.branchId === run.branchId) this.setUnsent(null);
    if (this.poolBlock()?.branchId === run.branchId) this.poolBlock.set(null);
    this.composer.sent(run.branchId, run.question);
    this.applyCommitted(res);
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

  private keepUnsent(branchId: string, text: string, options: SendOptions, needsKey = false): void {
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

  /**
   * Reports an error. No membership (402 membership_required) locks the own
   * key (the composer gives way to `KeyLockedNotice`, the message is kept);
   * out of credit (402 payment_required) goes to the billing page; a missing
   * or unreadable own key (401 key_required) opens the payment dialog; a pool
   * account without a human check on record (403 pool_unavailable, `verify`)
   * opens the check.
   */
  /** After a reply: the balance, and the pool meter while the pool is offered. */
  protected override alsoRefreshAfterReply(): Promise<unknown> {
    return Promise.all([
      this.account.refreshBalance(),
      this.account.payment.poolAvailable() ? this.account.refreshPool() : null,
    ]);
  }

  protected notify(text: string, kind?: 'info' | 'error'): void {
    this.toast.notify(text, kind);
  }

  fail(err: unknown): void {
    if (isMembershipRequired(err)) {
      this.account.membershipRequired();
      return;
    }
    if (isPoolUnavailable(err) && err.pool?.reason === 'verify') {
      this.ui.dialogs.open({ kind: 'pool-verify' });
      return;
    }
    if (err instanceof ApiError && err.code === 'key_required') {
      this.toast.notify(err.message, 'error');
      void this.account.refreshKey();
      this.ui.dialogs.open({ kind: 'access' });
      return;
    }
    if (isPaymentRequired(err)) {
      this.toast.notify(OUT_OF_CREDIT_MESSAGE, 'error');
      void this.account.refreshBalance();
      void this.router.navigate(['/billing']);
      return;
    }
    console.error(err);
    this.toast.notify(errorMessage(err), 'error');
  }

  /** Drops deleted branches and their messages, and stops following their replies. */
  protected override branchesRemoved(
    branchIds: ReadonlySet<string>,
    nodeIds: ReadonlySet<string>,
  ): void {
    const draft = this.unsentDraft();
    if (draft && branchIds.has(draft.branchId)) this.setUnsent(null);
    const block = this.poolBlock();
    if (block && branchIds.has(block.branchId)) this.poolBlock.set(null);
    // Connecting from a message that is gone, or back to a side question that is.
    const from = this.ui.dialogs.get('connect')?.sourceNodeId;
    if (from !== undefined && nodeIds.has(from)) this.ui.dialogs.close('connect');
    const back = this.linkReturn();
    if (back && (branchIds.has(back.branchId) || branchIds.has(back.toBranchId))) {
      this.linkReturn.set(null);
    }
  }

  protected override treeDeleted(treeId: string): void {
    if (this.unsentDraft()?.treeId === treeId) this.setUnsent(null);
  }
}
