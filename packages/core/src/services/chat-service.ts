import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_TREE_TITLE,
  TRUNK_TITLE,
  type Branch,
  type CandidateRequest,
  type ChatNode,
  type CommitCandidateResponse,
  type ContextPlanResponse,
  type CreateBranchRequest,
  type CreateLinkRequest,
  type CreateTreeRequest,
  type DeleteBranchResponse,
  type NodeLink,
  type ProviderRegistry,
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
import { Replier, type GroundingAllowance } from '../generation/reply.js';
import { ReviewService, type PreparedReview } from '../generation/review.js';
import {
  SendService,
  type BeginSendResult,
  type RunGenerationOptions,
} from '../generation/send.js';
import { Titler } from '../generation/titler.js';
import type { Repositories } from '../repository.js';
import { newId as defaultNewId, systemClock, type Clock } from '../util.js';
import { BackupService } from './backup.js';
import type { ServiceContext } from './context.js';
import { Ownership } from './ownership.js';
import { paysPerRequest, type GenerationProfile } from './profile.js';
import { RouteResolver } from './routing.js';
import type { ChatSettings } from './settings.js';
import { TreeService } from './tree-service.js';

export * from './settings.js';
export type { GenerationProfile, LearnProfile, PoolProfile, PowerProfile } from './profile.js';
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
   * The providers of `own-key` routes: the user's own keys (power), or every
   * route of the request whoever pays (Learn, which pays per request).
   */
  providers: ProviderRegistry;
  /** Which product this instance serves (`GenerationProfile`). Default: power without credit. */
  profile?: GenerationProfile;
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
  groundingAllowance?: GroundingAllowance;
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
  private readonly routes: RouteResolver;
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
    const profile = deps.profile ?? { kind: 'power' };
    this.owned = new Ownership(deps.repos.trees, this.accountId);
    this.routes = new RouteResolver(deps.providers, profile, deps.settings);
    const ctx: ServiceContext = {
      repos: deps.repos,
      accountId: this.accountId,
      owned: this.owned,
      routes: this.routes,
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
      paysPerRequest(profile) ? deps.providers : null,
    );
    this.resolver = new ContextResolver(ctx, profile);
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
   * `branch` on the route and model this service generates on it
   * (`RouteResolver.runnable`: Learn's own where the branch names one Learn
   * can't run). The stored branch is not changed.
   */
  runnableBranch(branch: Branch): Branch {
    return this.routes.runnable(branch);
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
