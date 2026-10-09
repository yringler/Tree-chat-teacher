import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_TREE_TITLE,
  TRUNK_TITLE,
  type Branch,
  type BranchFunding,
  type CandidateRequest,
  type ChatNode,
  type CommitCandidateResponse,
  type ContextPlanResponse,
  type CreateBranchRequest,
  type CreateLinkRequest,
  type CreateTreeRequest,
  type DefaultRouteFacts,
  type DeleteBranchResponse,
  type NodeLink,
  type ProviderRegistry,
  type ProviderRoute,
  type ReviewEvent,
  type ReviewRequest,
  type SettingsResponse,
  type StreamEvent,
  type Tree,
  type TreeBackup,
  type TreeBackupInput,
  type TreeDetail,
  type TreeSummary,
  type UpdateBranchRequest,
  type UpdateLinkRequest,
  type UpdateSettingsRequest,
  type UpdateTreeRequest,
} from '@tangent/shared';
import {
  CompareService,
  type CandidateRunEvent,
  type HeldCandidate,
  type PreparedCandidate,
} from '../generation/compare.js';
import {
  ContextResolver,
  type BranchInputBudget,
  type GenerationLimits,
} from '../generation/context-resolver.js';
import { Replier } from '../generation/reply.js';
import { ReviewService, type PreparedReview } from '../generation/review.js';
import {
  SendService,
  type BeginSendResult,
  type RunGenerationOptions,
} from '../generation/send.js';
import { Titler } from '../generation/titler.js';
import type { Repositories } from '../repository.js';
import type { TokenEstimator } from '../tokens.js';
import { newId as defaultNewId, systemClock, type Clock } from '../util.js';
import { BackupService } from './backup.js';
import type { ServiceContext } from './context.js';
import { Ownership } from './ownership.js';
import { RouteResolver } from './routing.js';
import type { ChatSettings } from './settings.js';
import { TreeService } from './tree-service.js';

export * from './settings.js';
export {
  pickGenerationLimits,
  type BranchInputBudget,
  type GenerationLimits,
} from '../generation/context-resolver.js';
export type { BeginSendResult, RunGenerationOptions } from '../generation/send.js';
export type { PreparedReview } from '../generation/review.js';
export type { CandidateRunEvent, HeldCandidate, PreparedCandidate } from '../generation/compare.js';
export { DEFAULT_TREE_TITLE, TRUNK_TITLE };

export interface ChatServiceDeps {
  repos: Repositories;
  /** Account acting through this service instance. Default DEFAULT_ACCOUNT_ID. */
  accountId?: string;
  /**
   * The providers of `own-key` routes: the user's own keys (power), or, with
   * `fixedFunding`, every route of the request whoever pays (Learn).
   */
  providers: ProviderRegistry;
  /**
   * The providers of `credit` routes (power: the built-in endpoint on the
   * operator's key, metered). Absent where Tangent credit isn't offered: a
   * branch on credit then has no provider. Unused with `fixedFunding`.
   */
  creditProviders?: ProviderRegistry;
  /**
   * Learn: how a request pays is decided per request, outside the branch, so
   * every route comes from `providers` whatever a branch's funding says, and
   * every branch this instance writes gets this funding (`own-key`).
   */
  fixedFunding?: BranchFunding;
  /**
   * Learn: imported backups are adapted to what Learn can show and continue
   * (`adaptBackupForLearn`): onto this instance's provider (`providers`'
   * default) and its models, `path` context, and the prompt a new tree gets.
   */
  adaptImportsForLearn?: boolean;
  /**
   * Power: what the default route of a new tree needs beyond the provider
   * lists (`pickDefaultRoute`): whether Tangent credit can pay now and
   * whether own keys need a membership the user lacks. Asked only for a new
   * tree that names neither a provider nor a funding, where credit is
   * offered. Absent: credit can't pay and nothing is locked, so a new tree
   * never defaults onto credit.
   */
  defaultRouteFacts?: () => Promise<DefaultRouteFacts>;
  settings: ChatSettings;
  /**
   * Built-in system prompt of new trees, used when neither the request nor
   * the account's saved settings name one. Default: none.
   */
  defaultSystemPrompt?: string | null;
  /**
   * False once automatic web searches on `route` should stop (the Worker's
   * daily cap on Tangent credit). Absent = always allowed. Explicit checks
   * ignore it.
   */
  groundingAllowance?: (route: ProviderRoute) => Promise<boolean>;
  /**
   * The one model every generation of this instance uses (replies, budgets,
   * summaries and titles without a configured summary model), whatever the
   * branch says; the branch row is not changed. The open pool sets it.
   */
  pinnedModel?: string;
  /**
   * The system prompt every generation of this instance uses instead of the
   * tree's own (the open pool's locked prompt). The tree is not changed.
   */
  systemPromptOverride?: string;
  /**
   * Makes the input budget a hard bound (the open pool): context budgets
   * are measured with `estimateTokens` instead of the default chars/3.5, and
   * every summary prompt is clipped to the summary model's input budget,
   * measured the same way, so no request of this instance exceeds it.
   */
  inputBound?: { estimateTokens: TokenEstimator };
  /**
   * The longest anchor quote generations of this instance use; longer ones
   * are clipped (the open pool: the quote is client-set free text, so it
   * gets no more room than a message). Default: unlimited.
   */
  anchorQuoteMaxChars?: number;
  /**
   * Where the service reports the failures it recovers from on its own (a
   * summary or title the provider failed, a token count, the grounding
   * allowance, …), which no caller sees otherwise: `event` names what
   * happened, `fields` the ids involved and the error. Absent: not reported.
   */
  log?: (event: string, fields: Record<string, unknown>) => void;
  clock?: Clock;
  newId?: () => string;
}

/**
 * Runtime-agnostic application service for trees, branches and messages.
 * The Worker wraps it in a Durable Object (one per tree) that owns
 * generations; a Node port would wrap it in an in-process per-tree mutex.
 * A facade: the work is done by TreeService, BackupService and the
 * generation services, which share one ServiceContext.
 */
export class ChatService {
  readonly accountId: string;
  private readonly owned: Ownership;
  private readonly trees: TreeService;
  private readonly backups: BackupService;
  private readonly resolver: ContextResolver;
  private readonly replier: Replier;
  private readonly sends: SendService;
  private readonly reviews: ReviewService;
  private readonly compares: CompareService;

  constructor(readonly deps: ChatServiceDeps) {
    this.accountId = deps.accountId ?? DEFAULT_ACCOUNT_ID;
    const clock = deps.clock ?? systemClock;
    const newId = deps.newId ?? (() => defaultNewId());
    this.owned = new Ownership(deps.repos.trees, this.accountId);
    const ctx: ServiceContext = {
      repos: deps.repos,
      accountId: this.accountId,
      owned: this.owned,
      routes: new RouteResolver(deps),
      settings: deps.settings,
      defaultSystemPrompt: deps.defaultSystemPrompt ?? null,
      now: () => clock().toISOString(),
      newId,
      log: (event, fields) => deps.log?.(event, fields),
    };
    this.trees = new TreeService(ctx);
    this.backups = new BackupService(
      ctx,
      this.trees,
      deps.adaptImportsForLearn ? deps.providers : null,
    );
    this.resolver = new ContextResolver(ctx, deps);
    this.replier = new Replier(ctx, this.resolver, deps.groundingAllowance);
    const titler = new Titler(ctx);
    this.sends = new SendService(ctx, this.resolver, this.replier, titler);
    this.reviews = new ReviewService(ctx, this.resolver);
    this.compares = new CompareService(ctx, this.resolver, this.replier, titler);
  }

  /**
   * Loads a branch whose tree is owned by this service's account. A missing
   * branch, or one in another account's tree, is reported as not found.
   */
  async getOwnedBranch(branchId: string): Promise<Branch> {
    return (await this.owned.branch(branchId)).branch;
  }

  /**
   * Loads a node whose tree is owned by this service's account. A missing
   * node, or one in another account's tree, is reported as not found.
   */
  getOwnedNode(nodeId: string): Promise<ChatNode> {
    return this.owned.node(nodeId);
  }

  // ------------------------------------------ trees, branches, links (TreeService)

  listTrees(): Promise<TreeSummary[]> {
    return this.trees.listTrees();
  }

  createTree(request: CreateTreeRequest): Promise<TreeDetail> {
    return this.trees.createTree(request);
  }

  getTreeDetail(treeId: string): Promise<TreeDetail> {
    return this.trees.getTreeDetail(treeId);
  }

  updateTree(treeId: string, request: UpdateTreeRequest): Promise<Tree> {
    return this.trees.updateTree(treeId, request);
  }

  deleteTree(treeId: string, options?: { stopGenerations?: () => Promise<void> }): Promise<void> {
    return this.trees.deleteTree(treeId, options);
  }

  getSettings(): Promise<SettingsResponse> {
    return this.trees.getSettings();
  }

  updateSettings(request: UpdateSettingsRequest): Promise<SettingsResponse> {
    return this.trees.updateSettings(request);
  }

  createBranch(request: CreateBranchRequest): Promise<Branch> {
    return this.trees.createBranch(request);
  }

  updateBranch(branchId: string, request: UpdateBranchRequest): Promise<Branch> {
    return this.trees.updateBranch(branchId, request);
  }

  deleteBranch(
    branchId: string,
    options?: { stopGenerations?: (branchIds: ReadonlySet<string>) => Promise<void> },
  ): Promise<DeleteBranchResponse> {
    return this.trees.deleteBranch(branchId, options);
  }

  createLink(request: CreateLinkRequest): Promise<{ link: NodeLink; created: boolean }> {
    return this.trees.createLink(request);
  }

  updateLink(linkId: string, request: UpdateLinkRequest): Promise<NodeLink> {
    return this.trees.updateLink(linkId, request);
  }

  deleteLink(linkId: string): Promise<void> {
    return this.trees.deleteLink(linkId);
  }

  recoverInterrupted(treeId: string): Promise<number> {
    return this.trees.recoverInterrupted(treeId);
  }

  recoverInterruptedNode(nodeId: string): Promise<ChatNode | null> {
    return this.trees.recoverInterruptedNode(nodeId);
  }

  // -------------------------------------------------------- backup (BackupService)

  exportBackup(treeId: string): Promise<TreeBackup> {
    return this.backups.exportBackup(treeId);
  }

  importBackup(backup: TreeBackup | TreeBackupInput): Promise<TreeDetail> {
    return this.backups.importBackup(backup);
  }

  // ---------------------------------------------------- context (ContextResolver)

  planContext(
    branchId: string,
    nodeId: string | null,
    options: { resolveSummaries: boolean; signal?: AbortSignal; limits?: GenerationLimits },
  ): Promise<ContextPlanResponse> {
    return this.resolver.planContext(branchId, nodeId, options);
  }

  routeBudget(
    route: Pick<Branch, 'providerId' | 'funding'>,
    model: string,
    limits?: GenerationLimits,
  ): Promise<{ maxInputTokens: number; maxOutputTokens: number }> {
    return this.resolver.routeBudget(route, model, limits);
  }

  inputBudget(branchId: string): Promise<BranchInputBudget> {
    return this.resolver.inputBudget(branchId);
  }

  // ------------------------------------------------------- generation services

  beginSend(branchId: string, content: string): Promise<BeginSendResult> {
    return this.sends.beginSend(branchId, content);
  }

  runGeneration(
    begin: BeginSendResult,
    signal: AbortSignal,
    options?: RunGenerationOptions,
  ): AsyncIterable<StreamEvent> {
    return this.sends.runGeneration(begin, signal, options);
  }

  canSearch(branch: Branch): boolean {
    return this.replier.canSearch(branch);
  }

  prepareReview(
    nodeId: string,
    request: ReviewRequest,
    limits?: GenerationLimits,
  ): Promise<PreparedReview> {
    return this.reviews.prepareReview(nodeId, request, limits);
  }

  runReview(review: PreparedReview, signal: AbortSignal): AsyncIterable<ReviewEvent> {
    return this.reviews.runReview(review, signal);
  }

  prepareCandidate(
    branchId: string,
    request: CandidateRequest,
    limits?: GenerationLimits,
  ): Promise<PreparedCandidate> {
    return this.compares.prepareCandidate(branchId, request, limits);
  }

  runCandidate(prepared: PreparedCandidate, signal: AbortSignal): AsyncIterable<CandidateRunEvent> {
    return this.compares.runCandidate(prepared, signal);
  }

  commitCandidate(held: HeldCandidate): Promise<CommitCandidateResponse> {
    return this.compares.commitCandidate(held);
  }

  appendCandidate(held: HeldCandidate): Promise<CommitCandidateResponse> {
    return this.compares.appendCandidate(held);
  }

  titleCommitted(committed: CommitCandidateResponse): Promise<Branch> {
    return this.compares.titleCommitted(committed);
  }
}
