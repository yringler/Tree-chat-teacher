import {
  CHECK_SOURCES_INSTRUCTIONS,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_GROUNDING_MODE,
  GROUNDING_INSTRUCTIONS,
  DEFAULT_TREE_TITLE,
  TRUNK_TITLE,
  REPLY_CANCELLED_ERROR,
  REPLY_CUT_OFF_ERROR,
  REPLY_EMPTY_ERROR,
  REPLY_THINKING_ONLY_ERROR,
  auxOutputTokens,
  isLengthStop,
  replyOutputTokens,
  type Branch,
  type BranchFunding,
  type CandidateEvent,
  type CandidateRequest,
  type ChatMessage,
  type ChatNode,
  type Citation,
  type CommitCandidateResponse,
  type ContextPlan,
  type ContextPlanResponse,
  type CreateBranchRequest,
  type CreateLinkRequest,
  type CreateTreeRequest,
  type DefaultRouteFacts,
  type DeleteBranchResponse,
  type InputOverflow,
  type LlmProvider,
  type NodeLink,
  type ProviderCapabilities,
  type ProviderError,
  type ProviderRegistry,
  type ProviderRoute,
  type ReasoningEffort,
  type ReviewEvent,
  type ReviewRequest,
  type SettingsResponse,
  type StreamEvent,
  type SummaryRequest,
  type TokenUsage,
  type Tree,
  type TreeBackup,
  type TreeBackupInput,
  type TreeDetail,
  type TreeSummary,
  type UpdateBranchRequest,
  type UpdateLinkRequest,
  type UpdateSettingsRequest,
  type UsageTag,
  type UpdateTreeRequest,
  type WebSearchRequest,
} from '@tangent/shared';
import { assembleContext, summaryKeyString } from '../context/assemble.js';
import { overflowBudget } from '../context/overflow.js';
import {
  buildReviewPrompt,
  buildSummaryPrompt,
  buildTitlePrompt,
  cleanTitle,
  renderPlan,
  replyInstructions,
  type RenderOptions,
} from '../context/render.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { decideGrounding, type GroundingDecision } from '../grounding/policy.js';
import { Ownership } from './ownership.js';
import { RouteResolver } from './routing.js';
import { BackupService } from './backup.js';
import { errorText, type ServiceContext } from './context.js';
import { TreeService } from './tree-service.js';
import type { Repositories } from '../repository.js';
import type { TokenEstimator } from '../tokens.js';
import { newId as defaultNewId, systemClock, type Clock } from '../util.js';

export * from './settings.js';
import type { ChatSettings } from './settings.js';

export { DEFAULT_TREE_TITLE, TRUNK_TITLE };

/**
 * The most summaries one send generates. Each is a paid call the reply waits
 * on, made one after another; 16 covers a chain nested deeper than anyone
 * branches by hand (fifteen summary-mode levels and a compaction), and
 * bounds an imported chain of hundreds to under a minute of waiting.
 */
const MAX_SUMMARY_CALLS = 16;
const TITLE_TIMEOUT_MS = 15_000;

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

/** `branch` with its anchor quote cut to `maxChars` (marked with an ellipsis). */
function clipAnchorQuote(branch: Branch, maxChars: number | undefined): Branch {
  const quote = branch.anchorQuote;
  if (maxChars === undefined || quote === null || quote.length <= maxChars) return branch;
  return { ...branch, anchorQuote: `${quote.slice(0, Math.max(0, maxChars - 1))}…` };
}

export interface BeginSendResult {
  branch: Branch;
  userNode: ChatNode;
  assistantNode: ChatNode;
}

/** Options of `runGeneration`. */
export interface RunGenerationOptions {
  /**
   * A reservation the caller already made for the reply (the open pool's
   * ceiling hold, or Tangent credit's least hold), passed to the provider as
   * `usageTag.reservationId`.
   */
  reservationId?: string;
  /** `required`: "Check sources", the reply must search (when the provider can). */
  ground?: 'required';
  /**
   * The reply's output cap the caller asks for (power's setting), instead of
   * the settings' default for the model; capped at the model's limit.
   */
  maxOutputTokens?: number;
  /**
   * The most input the caller lets the reply send (power's input limit),
   * below the input budget (the context window less the reply, within the
   * settings' `maxInputTokens`); never raises it.
   */
  maxInputTokens?: number;
  /** What a context over its input budget loses (`overflowBudget`); absent = `compact`. */
  inputOverflow?: InputOverflow;
}

/**
 * A generation's own limits (power's settings), as a send, a context preview,
 * a compare candidate or a review passes them.
 */
export type GenerationLimits = Pick<
  RunGenerationOptions,
  'maxOutputTokens' | 'maxInputTokens' | 'inputOverflow'
>;

/** Only the limits of `value` (e.g. a request that carries other fields too). */
export function pickGenerationLimits(value: GenerationLimits): GenerationLimits {
  const { maxOutputTokens, maxInputTokens, inputOverflow } = value;
  return {
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(inputOverflow !== undefined ? { inputOverflow } : {}),
  };
}

/** What bounds a reply's input on a branch's route (`inputBudget`). */
export interface BranchInputBudget {
  /** The branch's route: its provider and funding, and its model. */
  providerId: string;
  model: string;
  funding: BranchFunding;
  /** `ProviderCapabilities.maxContextTokens`. */
  contextTokens: number;
  /** `ProviderCapabilities.maxOutputTokens`. */
  maxOutputTokens: number;
  reasoning: boolean;
  /** The settings' input cap (`ChatSettings.maxInputTokens`). */
  maxInputTokens: number | null;
}

/**
 * `provider`'s capabilities for `model`, with its real limits where the
 * provider can look them up (`LlmProvider.resolveCapabilities`).
 */
function capabilitiesOf(provider: LlmProvider, model: string): Promise<ProviderCapabilities> {
  return provider.resolveCapabilities
    ? provider.resolveCapabilities(model)
    : Promise.resolve(provider.capabilities(model));
}

/** A validated review, ready to run (see `prepareReview`). */
export interface PreparedReview {
  node: ChatNode;
  providerId: string;
  funding: BranchFunding;
  model: string;
  /**
   * Power's limits, as the caller clamped them: the input limit bounds the
   * conversation the reviewer reads, the output cap the review.
   */
  limits: GenerationLimits;
}

/**
 * A validated compare candidate, ready to run (see `prepareCandidate`): the
 * question, answered as the next reply after `parentId` (the branch's leaf,
 * or its branch point when empty) on the given route and model.
 */
export interface PreparedCandidate {
  id: string;
  branch: Branch;
  parentId: string | null;
  content: string;
  providerId: string;
  funding: BranchFunding;
  model: string;
  /** Power's limits, as the caller clamped them (as for a send's `RunGenerationOptions`). */
  limits: GenerationLimits;
}

/**
 * A finished candidate, held (by the Worker, outside the tree) until the user
 * commits it or it expires. `question` is the user's message, `content` the
 * answer; `commitCandidate` appends both.
 */
export interface HeldCandidate {
  id: string;
  treeId: string;
  branchId: string;
  parentId: string | null;
  question: string;
  content: string;
  providerId: string;
  funding: BranchFunding;
  model: string;
  usage: TokenUsage | null;
  sources: Citation[] | null;
  createdAt: string;
}

/** `runCandidate`'s events: the wire CandidateEvent, but `done` carries the whole candidate. */
export type CandidateRunEvent =
  Exclude<CandidateEvent, { type: 'done' }> | { type: 'done'; candidate: HeldCandidate };

/** What `streamReply` has received so far (updated as it streams). */
interface ReplyState {
  content: string;
  usage: Partial<TokenUsage>;
  /** Sources of a web search the reply ran; null when it didn't search. */
  sources: Citation[] | null;
}

type ReplyEvent = Extract<StreamEvent, { type: 'status' | 'delta' | 'usage' }>;
type ReplyTerminal = { status: 'complete' } | { status: 'error'; message: string };

interface PlanInputs {
  tree: Tree;
  chain: Branch[];
  path: ChatNode[];
  branch: Branch;
  /**
   * The branch whose route summaries run on (without a summary provider):
   * `branch`, except for a compare candidate, where it is the stored branch,
   * so both candidates resolve the same summaries (cached once, on the
   * branch's model rather than each candidate's).
   */
  summaryBranch: Branch;
  targetNodeId: string | null;
  provider: LlmProvider;
}

/**
 * Runtime-agnostic application service for trees, branches and messages.
 * The Worker wraps it in a Durable Object (one per tree) that owns
 * generations; a Node port would wrap it in an in-process per-tree mutex.
 */
export class ChatService {
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly owned: Ownership;
  private readonly routes: RouteResolver;
  private readonly trees: TreeService;
  private readonly backups: BackupService;
  readonly accountId: string;

  constructor(readonly deps: ChatServiceDeps) {
    this.accountId = deps.accountId ?? DEFAULT_ACCOUNT_ID;
    this.clock = deps.clock ?? systemClock;
    this.newId = deps.newId ?? (() => defaultNewId());
    this.owned = new Ownership(deps.repos.trees, this.accountId);
    this.routes = new RouteResolver(deps);
    const ctx: ServiceContext = {
      repos: deps.repos,
      accountId: this.accountId,
      owned: this.owned,
      routes: this.routes,
      settings: deps.settings,
      defaultSystemPrompt: deps.defaultSystemPrompt ?? null,
      now: () => this.now(),
      newId: () => this.newId(),
      log: (event, fields) => this.log(event, fields),
    };
    this.trees = new TreeService(ctx);
    this.backups = new BackupService(
      ctx,
      this.trees,
      deps.adaptImportsForLearn ? deps.providers : null,
    );
  }

  private get repo() {
    return this.deps.repos.trees;
  }

  private now(): string {
    return this.clock().toISOString();
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

  // ------------------------------------------- trees, branches, links (TreeService)

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

  // --------------------------------------------------------- backup (BackupService)

  exportBackup(treeId: string): Promise<TreeBackup> {
    return this.backups.exportBackup(treeId);
  }

  importBackup(backup: TreeBackup | TreeBackupInput): Promise<TreeDetail> {
    return this.backups.importBackup(backup);
  }

  // -------------------------------------------------------------- context

  /**
   * Plans the context for replying at `nodeId` (default: branch leaf). With
   * `resolveSummaries`, missing summaries are generated (and cached) first.
   */
  async planContext(
    branchId: string,
    nodeId: string | null,
    options: { resolveSummaries: boolean; signal?: AbortSignal; limits?: GenerationLimits },
  ): Promise<ContextPlanResponse> {
    const inputs = await this.loadPlanInputs(branchId, nodeId);
    const steps = this.resolvePlan(
      inputs,
      options.resolveSummaries,
      options.signal,
      options.limits,
    );
    let step = await steps.next();
    while (!step.done) step = await steps.next();
    const plan = step.value;
    const model = this.routes.modelOf(inputs.branch);
    const caps = inputs.provider.capabilities(model);
    const rendered = renderPlan(plan, this.renderOptions(caps.supportsSystemPrompt));
    let exactInputTokens: number | null = null;
    if (caps.supportsTokenCount && inputs.provider.countTokens && rendered.messages.length > 0) {
      try {
        exactInputTokens = await inputs.provider.countTokens({
          model,
          system: rendered.system,
          messages: rendered.messages,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (err) {
        exactInputTokens = null;
        // A count the caller cancelled didn't fail.
        if (!options.signal?.aborted)
          this.log('count_tokens_failed', {
            treeId: inputs.tree.id,
            branchId: inputs.branch.id,
            providerId: inputs.provider.id,
            model,
            error: errorText(err),
          });
      }
    }
    return {
      plan,
      rendered,
      providerId: inputs.branch.providerId,
      funding: this.routes.fundingOf(inputs.branch),
      model,
      exactInputTokens,
    };
  }

  /**
   * Loads everything needed to plan a reply in an owned branch. A `nodeId`
   * must belong to that branch (and hence to the same owned tree).
   *
   * `extra` plans a reply that is not in the tree (a compare candidate):
   * `tail` is an unsaved user node appended after its parent (with `nodeId`
   * null) and becomes the target; `route` replaces the branch's route and
   * model in memory, so the budget, provider and grounding allowance follow
   * it; summaries stay on the stored branch's route (`summaryBranch`). The
   * branch row is not changed.
   */
  private async loadPlanInputs(
    branchId: string,
    nodeId: string | null,
    extra: { tail?: ChatNode; route?: ProviderRoute & { model: string } } = {},
  ): Promise<PlanInputs> {
    const owned = await this.owned.branch(branchId);
    // The only way into the context's system prompt (the `tree-system-prompt` segment).
    const override = this.deps.systemPromptOverride;
    const tree = override === undefined ? owned.tree : { ...owned.tree, systemPrompt: override };
    const clip = (b: Branch): Branch => clipAnchorQuote(b, this.deps.anchorQuoteMaxChars);
    const route = extra.route;
    const routed = (b: Branch): Branch =>
      route && b.id === branchId
        ? { ...b, providerId: route.providerId, funding: route.funding, model: route.model }
        : b;
    const stored = clip(owned.branch);
    const branch = routed(stored);
    const chain = (await this.repo.getBranchChain(branchId)).map((b) => routed(clip(b)));

    const tail = extra.tail;
    let path: ChatNode[];
    if (tail) {
      path = [...(tail.parentId ? await this.repo.getAncestorPath(tail.parentId) : []), tail];
    } else if (nodeId) {
      const node = await this.repo.getNode(nodeId);
      if (!node || node.branchId !== branchId)
        throw new ValidationError('Node is not in this branch');
      path = await this.repo.getAncestorPath(nodeId);
    } else {
      const own = await this.repo.listBranchNodes(branchId);
      const leaf = own.at(-1);
      const tail = leaf?.id ?? branch.branchPointNodeId;
      path = tail ? await this.repo.getAncestorPath(tail) : [];
    }
    // With a locked prompt, a stored `system` node (e.g. from an imported
    // backup) must not reach the system channel: it is planned as a user turn.
    if (override !== undefined) {
      path = path.map((n) => (n.role === 'system' ? { ...n, role: 'user' } : n));
    }
    const provider = this.routes.requireProvider(branch);
    return {
      tree,
      chain,
      path,
      branch,
      summaryBranch: stored,
      targetNodeId: tail?.id ?? nodeId,
      provider,
    };
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.deps.log?.(event, fields);
  }

  private renderOptions(supportsSystemPrompt: boolean): RenderOptions {
    return { supportsSystemPrompt };
  }

  /**
   * A reply's output cap on `model` (`requested`, else the settings' default
   * for a reasoning or a plain model, within the model's limit) and the input
   * budget that leaves in its context window, within the settings' cap and
   * `requestedInput` (power's input limit).
   */
  private async budgetFor(
    provider: LlmProvider,
    model: string,
    requested?: number,
    requestedInput?: number,
  ): Promise<{ maxInputTokens: number; maxOutput: number }> {
    const caps = await capabilitiesOf(provider, model);
    const { reservedOutputTokens, reasoningOutputTokens } = this.deps.settings;
    const maxOutput = replyOutputTokens({
      reasoning: caps.reasoning === true,
      maxOutputTokens: caps.maxOutputTokens,
      requested: requested ?? null,
      defaults: { plain: reservedOutputTokens, reasoning: reasoningOutputTokens },
    });
    let maxInputTokens = Math.max(1, caps.maxContextTokens - maxOutput);
    if (this.deps.settings.maxInputTokens !== null) {
      maxInputTokens = Math.min(maxInputTokens, this.deps.settings.maxInputTokens);
    }
    if (requestedInput !== undefined) maxInputTokens = Math.min(maxInputTokens, requestedInput);
    return { maxInputTokens, maxOutput };
  }

  /**
   * The input budget and output cap a reply on `route` and `model` runs
   * with, under `limits` (`budgetFor`): what a reply's cost is bounded by
   * before its prompt exists (the Worker holds Tangent credit for it).
   */
  async routeBudget(
    route: Pick<Branch, 'providerId' | 'funding'>,
    model: string,
    limits: GenerationLimits = {},
  ): Promise<{ maxInputTokens: number; maxOutputTokens: number }> {
    const { maxInputTokens, maxOutput } = await this.budgetFor(
      this.routes.requireProvider(route),
      this.routes.modelOf({ model }),
      limits.maxOutputTokens,
      limits.maxInputTokens,
    );
    return { maxInputTokens, maxOutputTokens: maxOutput };
  }

  /**
   * What bounds a reply's input on an owned branch's route and model (for
   * power's input limit setting): the model's window and output limit, and
   * the settings' input cap. `budgetFor` works the budget out from these.
   */
  async inputBudget(branchId: string): Promise<BranchInputBudget> {
    const branch = await this.getOwnedBranch(branchId);
    const model = this.routes.modelOf(branch);
    const caps = await capabilitiesOf(this.routes.requireProvider(branch), model);
    return {
      providerId: branch.providerId,
      model,
      funding: this.routes.fundingOf(branch),
      contextTokens: caps.maxContextTokens,
      maxOutputTokens: caps.maxOutputTokens,
      reasoning: caps.reasoning === true,
      maxInputTokens: this.deps.settings.maxInputTokens,
    };
  }

  /**
   * Plan → (cache lookup | generate) missing summaries → re-plan, until the
   * plan is complete or nothing changes. Summaries nest (a summary-mode
   * branch summarizes a context that holds its parent's summary, and a
   * compaction can hold any of them), so they resolve inner-first, a level
   * per round: a round that only found cached summaries is free (each finds
   * one it hadn't, so there are no more of them than cached summaries), and the
   * rounds that generate are bounded by the levels there can be: one per
   * branch below the trunk, and one compaction. One resolve makes at most
   * MAX_SUMMARY_CALLS summary calls and goes without the summaries still
   * missing; what it made is cached, so the next one goes on from there.
   * Yields human-readable status messages; returns the final plan.
   */
  private async *resolvePlan(
    inputs: PlanInputs,
    generate: boolean,
    signal?: AbortSignal,
    limits: GenerationLimits = {},
  ): AsyncGenerator<string, ContextPlan> {
    const summaries = new Map<string, string>();
    const failed = new Set<string>();
    const { provider: summaryProvider, model: summaryModel } = this.routes.summaryTarget(
      inputs.summaryBranch,
    );
    const { maxInputTokens } = await this.budgetFor(
      inputs.provider,
      this.routes.modelOf(inputs.branch),
      limits.maxOutputTokens,
      limits.maxInputTokens,
    );
    const lookedUp = new Set<string>();

    const plan = (): ContextPlan =>
      assembleContext({
        tree: inputs.tree,
        branches: inputs.chain,
        nodes: inputs.path,
        targetBranchId: inputs.branch.id,
        targetNodeId: inputs.targetNodeId,
        summaries,
        failedSummaries: failed,
        budget: { maxInputTokens, ...overflowBudget(limits.inputOverflow) },
        ...(this.deps.inputBound ? { estimateTokens: this.deps.inputBound.estimateTokens } : {}),
      });

    let current = plan();
    const maxGeneratingRounds = inputs.chain.length;
    let calls = 0;
    let generatingRounds = 0;
    for (;;) {
      // 1. Cache lookups for every pending summary we haven't looked up yet.
      // Requests can name inner summaries that have no segment of their own
      // (nested summary modes), so check both.
      let progressed = false;
      const keys = [
        ...current.segments.flatMap((s) =>
          s.kind === 'summary' && s.status === 'pending' ? [s.key] : [],
        ),
        ...current.pendingSummaries.map((r) => r.key),
      ];
      for (const key of keys) {
        const k = summaryKeyString(key);
        if (lookedUp.has(k)) continue;
        lookedUp.add(k);
        const hit = await this.deps.repos.summaries.getSummary(
          key.anchorNodeId,
          key.sourceHash,
          summaryModel,
        );
        if (hit) {
          summaries.set(k, hit.content);
          progressed = true;
        }
      }
      if (progressed) {
        current = plan();
        continue;
      }
      if (!generate || current.pendingSummaries.length === 0) return current;
      if (generatingRounds === maxGeneratingRounds) return current;
      generatingRounds++;

      // 2. Generate what is still missing.
      for (const request of current.pendingSummaries) {
        const k = summaryKeyString(request.key);
        if (summaries.has(k) || failed.has(k)) continue;
        if (calls === MAX_SUMMARY_CALLS) return plan();
        calls++;
        yield request.purpose === 'branch'
          ? 'Summarizing the parent conversation…'
          : 'Compacting older messages to fit the context window…';
        const text = await this.generateSummary(
          summaryProvider,
          summaryModel,
          request,
          { treeId: inputs.tree.id, branchId: inputs.branch.id },
          signal,
        );
        if (text === null) {
          failed.add(k);
          continue;
        }
        summaries.set(k, text);
        await this.deps.repos.summaries.putSummary({
          anchorNodeId: request.key.anchorNodeId,
          sourceHash: request.key.sourceHash,
          providerId: summaryProvider.id,
          model: summaryModel,
          content: text,
          treeId: inputs.tree.id,
          createdAt: this.now(),
        });
      }
      current = plan();
      if (current.complete) return current;
    }
  }

  private async generateSummary(
    provider: LlmProvider,
    model: string,
    request: SummaryRequest,
    target: { treeId: string; branchId: string },
    signal?: AbortSignal,
  ): Promise<string | null> {
    const bound = this.deps.inputBound;
    const prompt = buildSummaryPrompt(
      request,
      bound && {
        maxInputTokens: (await this.budgetFor(provider, model)).maxInputTokens,
        estimateTokens: bound.estimateTokens,
      },
    );
    if (prompt === null) return null;
    const text = await collectText(
      provider,
      model,
      prompt,
      signal ?? new AbortController().signal,
      { purpose: 'summary', ...target, nodeId: null },
      this.deps.settings.summaryEffort,
      (error) => {
        // A summary cut short by a cancelled send didn't fail.
        if (signal?.aborted) return;
        this.log('summary_failed', {
          ...target,
          providerId: provider.id,
          model,
          code: error.code,
          error: error.message,
        });
      },
    );
    return text?.trim() ? text.trim() : null;
  }

  // ------------------------------------------------------------ messages

  /**
   * Appends a user node to the branch leaf (or the branch point for an empty
   * branch) and a `streaming` assistant node after it, atomically.
   * Rejects with ConflictError if the branch leaf is still streaming.
   */
  async beginSend(branchId: string, content: string): Promise<BeginSendResult> {
    const branch = await this.getOwnedBranch(branchId);
    if (!content.trim()) throw new ValidationError('Message is empty');
    this.routes.requireProvider(branch);
    const own = await this.repo.listBranchNodes(branchId);
    const leaf = own.at(-1);
    if (leaf?.status === 'streaming') {
      throw new ConflictError('A reply is still being generated in this branch');
    }
    const now = this.now();
    const seq = leaf ? leaf.seq + 1 : 0;
    const userNode: ChatNode = {
      id: this.newId(),
      treeId: branch.treeId,
      branchId,
      parentId: leaf?.id ?? branch.branchPointNodeId,
      seq,
      role: 'user',
      content,
      status: 'complete',
      error: null,
      providerId: null,
      model: null,
      usage: null,
      createdAt: now,
    };
    const assistantNode: ChatNode = {
      id: this.newId(),
      treeId: branch.treeId,
      branchId,
      parentId: userNode.id,
      seq: seq + 1,
      role: 'assistant',
      content: '',
      status: 'streaming',
      error: null,
      providerId: branch.providerId,
      model: this.routes.modelOf(branch),
      usage: null,
      createdAt: now,
    };
    await this.repo.appendNodes([userNode, assistantNode], now);
    return { branch, userNode, assistantNode };
  }

  /**
   * Runs the generation for a `beginSend` result: resolves summaries (yielding
   * `status`), streams `delta`/`usage`, then persists the assistant node and
   * yields exactly one terminal `done` or `error`. Never throws. Persists
   * partial content on abort/error. Auto-titles the branch when enabled.
   *
   * Grounding: `decideGrounding` picks whether this reply is offered a web
   * search (or must run one, for `options.ground`); the found sources are
   * stored on the node (`sources`: null when it didn't search). A provider
   * that rejects the search request before any text is retried once without.
   */
  async *runGeneration(
    begin: BeginSendResult,
    signal: AbortSignal,
    options: RunGenerationOptions = {},
  ): AsyncIterable<StreamEvent> {
    const { assistantNode, userNode } = begin;
    let branch = begin.branch;
    const state: ReplyState = { content: '', usage: {}, sources: null };
    const finish = async (
      status: 'complete' | 'error',
      error: string | null,
    ): Promise<ChatNode> => {
      const { content, sources } = state;
      const finalUsage = finalTokenUsage(state.usage);
      const node: ChatNode = {
        ...assistantNode,
        content,
        status,
        error,
        usage: finalUsage,
        sources,
      };
      await this.repo.updateNode(assistantNode.id, {
        content,
        status,
        error,
        usage: finalUsage,
        sources,
      });
      return node;
    };

    try {
      const inputs = await this.loadPlanInputs(branch.id, userNode.id);
      branch = inputs.branch;
      const steps = this.resolvePlan(inputs, true, signal, options);
      let step = await steps.next();
      while (!step.done) {
        yield { type: 'status', message: step.value };
        step = await steps.next();
      }
      const plan = step.value;
      if (missesSummary(plan)) yield { type: 'status', message: SUMMARY_MISSING_STATUS };
      const model = this.routes.modelOf(branch);
      const caps = inputs.provider.capabilities(model);
      const grounding = await this.decideGrounding(inputs, plan, caps.supportsWebSearch, options);
      const terminal = yield* this.streamReply(
        {
          provider: inputs.provider,
          plan,
          model,
          caps,
          grounding,
          usageTag: {
            purpose: 'reply',
            treeId: inputs.tree.id,
            branchId: branch.id,
            nodeId: assistantNode.id,
            ...(options.reservationId ? { reservationId: options.reservationId } : {}),
          },
          nodeId: assistantNode.id,
          ...(options.maxOutputTokens !== undefined
            ? { maxOutputTokens: options.maxOutputTokens }
            : {}),
        },
        state,
        signal,
      );

      if (terminal.status === 'error') {
        const node = await finish('error', terminal.message);
        yield { type: 'error', nodeId: node.id, message: terminal.message, node };
        return;
      }
      const node = await finish('complete', null);
      if (this.deps.settings.autoTitle && node.seq === 1) {
        branch = (await this.autoTitle(inputs.tree, branch, userNode, node)) ?? branch;
      }
      yield { type: 'done', node, branch };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Generation failed';
      let node: ChatNode | null;
      try {
        node = await finish('error', message);
      } catch (saveErr) {
        node = null;
        this.log('reply_save_failed', {
          treeId: assistantNode.treeId,
          branchId: assistantNode.branchId,
          nodeId: assistantNode.id,
          reply: message,
          error: errorText(saveErr),
        });
      }
      yield { type: 'error', nodeId: assistantNode.id, message, node };
    }
  }

  /**
   * Streams one reply to a planned context: renders it (the grounding
   * instructions go after the history, as `turnInstructions`, when a search
   * is offered), yields `delta`/`usage` for
   * `target.nodeId` and `status` messages, and accumulates the text, usage
   * and found sources into `state` as they arrive (so a caller that fails
   * midway still has the partial reply). A provider that rejects the search
   * request before any text is retried once without it. Returns the outcome;
   * persists nothing. A reply cut off at its output cap, or one without any
   * text, is an error outcome (`replyOutcome`), so a caller stores it as an
   * `error` node that keeps the partial text, never as a complete answer.
   */
  private async *streamReply(
    target: {
      provider: LlmProvider;
      plan: ContextPlan;
      model: string;
      caps: ProviderCapabilities;
      grounding: GroundingDecision;
      usageTag: UsageTag;
      /** The node the `delta`/`usage` events are for. */
      nodeId: string;
      /** The output cap the caller asks for (RunGenerationOptions.maxOutputTokens). */
      maxOutputTokens?: number;
    },
    state: ReplyState,
    signal: AbortSignal,
  ): AsyncGenerator<ReplyEvent, ReplyTerminal> {
    const { provider, plan, model, caps, nodeId } = target;
    const { maxOutput } = await this.budgetFor(provider, model, target.maxOutputTokens);
    let terminal: ReplyTerminal | null = null;
    let webSearch = this.webSearchRequest(target.grounding);
    for (let attempt = 0; attempt < 2; attempt++) {
      let retryWithoutSearch = false;
      // After the history, not in the system prompt: see `replyInstructions`.
      const turnInstructions =
        webSearch === undefined
          ? undefined
          : replyInstructions(
              webSearch.mode === 'required' ? CHECK_SOURCES_INSTRUCTIONS : GROUNDING_INSTRUCTIONS,
            );
      const rendered = renderPlan(plan, this.renderOptions(caps.supportsSystemPrompt));
      let searched = false;
      let cited: Citation[] = [];
      for await (const event of provider.stream({
        model,
        system: rendered.system,
        messages: rendered.messages,
        maxOutputTokens: maxOutput,
        signal,
        usageTag: target.usageTag,
        ...(webSearch !== undefined ? { webSearch } : {}),
        ...(turnInstructions !== undefined ? { turnInstructions } : {}),
      })) {
        if (event.type === 'delta') {
          state.content += event.text;
          yield { type: 'delta', nodeId, text: event.text };
        } else if (event.type === 'usage') {
          Object.assign(state.usage, stripUndefined(event.usage));
          yield { type: 'usage', nodeId, usage: event.usage };
        } else if (event.type === 'done') {
          terminal = replyOutcome(state.content, event.stopReason);
        } else if (event.type === 'billing') {
          // Metered by the Worker's registry wrapper; only the search count matters here.
          if ((event.webSearches ?? 0) > 0) searched = true;
        } else if (event.type === 'activity') {
          if (!searched) yield { type: 'status', message: 'Checking sources…' };
          searched = true;
        } else if (event.type === 'citations') {
          searched = true;
          cited = event.citations;
        } else if (
          webSearch !== undefined &&
          attempt === 0 &&
          state.content === '' &&
          event.error.code === 'invalid_request'
        ) {
          // The provider (or this model) refused the search tool: answer without it.
          webSearch = undefined;
          retryWithoutSearch = true;
          yield {
            type: 'status',
            message: "Couldn't check sources; answering from the tutor's own knowledge.",
          };
          break;
        } else {
          terminal = {
            status: 'error',
            message: event.error.code === 'aborted' ? REPLY_CANCELLED_ERROR : event.error.message,
          };
        }
      }
      if (searched) state.sources = cited;
      if (!retryWithoutSearch) break;
    }
    return terminal ?? { status: 'error', message: 'The provider stream ended unexpectedly' };
  }

  /** Whether replies on `branch` can run a web search ("Check sources"). */
  canSearch(branch: Branch): boolean {
    try {
      return this.routes.requireProvider(branch).capabilities(this.routes.modelOf(branch))
        .supportsWebSearch;
    } catch (err) {
      this.log('can_search_failed', {
        branchId: branch.id,
        providerId: branch.providerId,
        error: errorText(err),
      });
      return false;
    }
  }

  /** Whether this reply is offered (or must run) a web search. */
  private async decideGrounding(
    inputs: PlanInputs,
    plan: ContextPlan,
    supported: boolean,
    options: RunGenerationOptions,
  ): Promise<GroundingDecision> {
    const settings = this.deps.settings.grounding;
    const lastUser = inputs.path.at(-1);
    const input = {
      policy: settings.policy,
      branchMode: settings.ignoreBranchSetting
        ? DEFAULT_GROUNDING_MODE
        : (inputs.branch.grounding ?? DEFAULT_GROUNDING_MODE),
      explicit: options.ground === 'required',
      supported,
      autoAllowed: true,
      depth: Math.max(0, inputs.chain.length - 1),
      userText: lastUser?.role === 'user' ? lastUser.content : '',
      lossyContext:
        plan.compaction !== null ||
        plan.segments.some((s) => s.kind === 'summary' && s.status === 'ready'),
    };
    const decision = decideGrounding(input);
    // Only an automatic search that would otherwise run consults the (I/O) cap.
    if (decision.mode !== 'auto' || !this.deps.groundingAllowance) return decision;
    const route = { providerId: inputs.branch.providerId, funding: inputs.branch.funding };
    let allowed: boolean;
    try {
      allowed = await this.deps.groundingAllowance(route);
    } catch (err) {
      allowed = false;
      this.log('grounding_allowance_failed', { ...route, error: errorText(err) });
    }
    return allowed ? decision : decideGrounding({ ...input, autoAllowed: false });
  }

  private webSearchRequest(decision: GroundingDecision): WebSearchRequest | undefined {
    if (decision.mode === 'none') return undefined;
    const { maxResults, maxUses, engine } = this.deps.settings.grounding;
    return { mode: decision.mode, maxResults, maxUses, engine };
  }

  /** Titles a default-titled branch (and a default-titled tree, for the trunk). Best-effort. */
  private async autoTitle(
    tree: Tree,
    branch: Branch,
    userNode: ChatNode,
    assistantNode: ChatNode,
  ): Promise<Branch | null> {
    const isTrunk = branch.parentBranchId === null;
    const titleBranch = branch.titleSource === 'default' && !isTrunk;
    const titleTree = isTrunk && tree.title === DEFAULT_TREE_TITLE;
    if (!titleBranch && !titleTree) return null;
    try {
      const { provider, model } = this.routes.summaryTarget(branch);
      // The test provider (kind `fake`) would just echo the prompt; keep the readable default title.
      if (provider.kind === 'fake') return null;
      const messages: ChatMessage[] = [];
      if (branch.anchorQuote)
        messages.push({ role: 'user', content: `Focus: ${branch.anchorQuote}` });
      messages.push({ role: 'user', content: userNode.content });
      messages.push({ role: 'assistant', content: assistantNode.content.slice(0, 4000) });
      const raw = await collectText(
        provider,
        model,
        buildTitlePrompt(messages),
        AbortSignal.timeout(TITLE_TIMEOUT_MS),
        { purpose: 'title', treeId: tree.id, branchId: branch.id, nodeId: null },
        this.deps.settings.summaryEffort,
        (error) =>
          this.log('auto_title_failed', {
            treeId: tree.id,
            branchId: branch.id,
            providerId: provider.id,
            model,
            code: error.code,
            error: error.message,
          }),
      );
      const title = raw ? cleanTitle(raw) : null;
      if (!title) return null;
      const now = this.now();
      if (titleTree) await this.repo.updateTree(tree.id, { title, updatedAt: now });
      if (titleBranch) {
        return await this.repo.updateBranch(branch.id, {
          title,
          titleSource: 'auto',
          updatedAt: now,
        });
      }
      return null;
    } catch (err) {
      this.log('auto_title_failed', {
        treeId: tree.id,
        branchId: branch.id,
        error: errorText(err),
      });
      return null;
    }
  }

  // -------------------------------------------------------------- reviews

  /**
   * Validates a review of the conversation up to `nodeId` before any stream
   * opens, so bad requests fail as plain HTTP errors. Only finished
   * assistant replies can be reviewed.
   */
  async prepareReview(
    nodeId: string,
    request: ReviewRequest,
    limits: GenerationLimits = {},
  ): Promise<PreparedReview> {
    const node = await this.getOwnedNode(nodeId);
    if (node.role !== 'assistant')
      throw new ValidationError('Only assistant replies can be reviewed');
    if (node.status !== 'complete') throw new ValidationError('That reply has not finished');
    const route = this.routes.requestedRoute(request, null);
    this.routes.requireProvider(route);
    return { node, ...route, model: request.model, limits: pickGenerationLimits(limits) };
  }

  /**
   * Streams a review. The reviewer gets the context exactly as the branch's
   * model rendered it for this reply (summaries resolved and cached like a
   * normal send), followed by the reply itself. Nothing is persisted.
   * Power's input limit (`review.limits`) bounds that context like a send's
   * (on the branch's model, whose reply it is), and its output cap the review.
   * Never throws; ends with exactly one `done` or `error`.
   */
  async *runReview(review: PreparedReview, signal: AbortSignal): AsyncIterable<ReviewEvent> {
    try {
      const inputs = await this.loadPlanInputs(review.node.branchId, review.node.id);
      // The output cap is the review's, not a reply's on the branch's model.
      const { maxOutputTokens: reviewOutput, ...contextLimits } = review.limits;
      const steps = this.resolvePlan(inputs, true, signal, contextLimits);
      let step = await steps.next();
      while (!step.done) {
        yield { type: 'status', message: step.value };
        step = await steps.next();
      }
      const caps = inputs.provider.capabilities(this.routes.modelOf(inputs.branch));
      const context = renderPlan(step.value, this.renderOptions(caps.supportsSystemPrompt));
      const reviewer = this.routes.requireProvider(review);
      const prompt = buildReviewPrompt(context, review.node.model);
      const rendered = reviewer.capabilities(review.model).supportsSystemPrompt
        ? prompt
        : foldSystem(prompt);
      const { maxOutput } = await this.budgetFor(reviewer, review.model, reviewOutput);
      yield { type: 'status', message: 'Reviewing…' };

      const usage: Partial<TokenUsage> = {};
      for await (const event of reviewer.stream({
        model: review.model,
        system: rendered.system,
        messages: rendered.messages,
        maxOutputTokens: maxOutput,
        signal,
        usageTag: {
          purpose: 'review',
          treeId: review.node.treeId,
          branchId: review.node.branchId,
          nodeId: review.node.id,
        },
      })) {
        if (event.type === 'delta') yield { type: 'delta', text: event.text };
        else if (event.type === 'usage') Object.assign(usage, stripUndefined(event.usage));
        else if (
          event.type === 'billing' ||
          event.type === 'citations' ||
          event.type === 'activity'
        )
          continue;
        else if (event.type === 'done') {
          yield {
            type: 'done',
            providerId: review.providerId,
            funding: review.funding,
            model: review.model,
            usage: finalTokenUsage(usage),
          };
          return;
        } else {
          yield {
            type: 'error',
            message: event.error.code === 'aborted' ? REPLY_CANCELLED_ERROR : event.error.message,
          };
          return;
        }
      }
      yield { type: 'error', message: 'The provider stream ended unexpectedly' };
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : 'Review failed' };
    }
  }

  // ------------------------------------------------------------- compare

  /**
   * Validates a compare candidate before any stream opens, so bad requests
   * fail as plain HTTP errors: the question must not be empty and no reply
   * may be streaming in the branch. A request without a provider runs on the
   * branch's route (Learn's fixed funding applies). The candidate answers
   * after the branch's current leaf.
   */
  async prepareCandidate(
    branchId: string,
    request: CandidateRequest,
    limits: GenerationLimits = {},
  ): Promise<PreparedCandidate> {
    const branch = await this.getOwnedBranch(branchId);
    if (!request.content.trim()) throw new ValidationError('Message is empty');
    const leaf = (await this.repo.listBranchNodes(branchId)).at(-1);
    if (leaf?.status === 'streaming') {
      throw new ConflictError('A reply is still being generated in this branch');
    }
    const route = this.routes.requestedRoute(request, branch);
    this.routes.requireProvider(route);
    return {
      id: this.newId(),
      branch,
      parentId: leaf?.id ?? branch.branchPointNodeId,
      content: request.content,
      ...route,
      model: request.model,
      limits: pickGenerationLimits(limits),
    };
  }

  /**
   * Streams a candidate reply: the context is planned as if the question had
   * been sent (summaries resolved and cached like a normal send) on the
   * candidate's route and model, and the reply streams exactly as
   * `runGeneration` would stream it (grounding included) with the
   * candidate's limits (power's, as a send takes them), metered as a
   * `reply` with no node. Nothing is persisted: `done` carries the finished
   * candidate for the caller to hold. Never throws; ends with exactly one
   * `done` or `error`.
   */
  async *runCandidate(
    prepared: PreparedCandidate,
    signal: AbortSignal,
  ): AsyncIterable<CandidateRunEvent> {
    try {
      const branchId = prepared.branch.id;
      const parent = prepared.parentId ? await this.repo.getNode(prepared.parentId) : null;
      const question: ChatNode = {
        id: `${prepared.id}:q`,
        treeId: prepared.branch.treeId,
        branchId,
        parentId: prepared.parentId,
        seq: parent?.branchId === branchId ? parent.seq + 1 : 0,
        role: 'user',
        content: prepared.content,
        status: 'complete',
        error: null,
        providerId: null,
        model: null,
        usage: null,
        createdAt: this.now(),
      };
      const inputs = await this.loadPlanInputs(branchId, null, {
        tail: question,
        route: {
          providerId: prepared.providerId,
          funding: prepared.funding,
          model: prepared.model,
        },
      });
      const steps = this.resolvePlan(inputs, true, signal, prepared.limits);
      let step = await steps.next();
      while (!step.done) {
        yield { type: 'status', message: step.value };
        step = await steps.next();
      }
      const plan = step.value;
      if (missesSummary(plan)) yield { type: 'status', message: SUMMARY_MISSING_STATUS };
      const model = this.routes.modelOf(inputs.branch);
      const caps = inputs.provider.capabilities(model);
      const grounding = await this.decideGrounding(inputs, plan, caps.supportsWebSearch, {});
      const state: ReplyState = { content: '', usage: {}, sources: null };
      const reply = this.streamReply(
        {
          provider: inputs.provider,
          plan,
          model,
          caps,
          grounding,
          usageTag: { purpose: 'reply', treeId: inputs.tree.id, branchId, nodeId: null },
          nodeId: question.id,
          ...(prepared.limits.maxOutputTokens !== undefined
            ? { maxOutputTokens: prepared.limits.maxOutputTokens }
            : {}),
        },
        state,
        signal,
      );
      let next = await reply.next();
      while (!next.done) {
        const event = next.value;
        // Usage is accumulated into `state` and reported once, with `done`.
        if (event.type === 'delta') yield { type: 'delta', text: event.text };
        else if (event.type === 'status') yield event;
        next = await reply.next();
      }
      const terminal = next.value;
      if (terminal.status === 'error') {
        yield { type: 'error', message: terminal.message };
        return;
      }
      yield {
        type: 'done',
        candidate: {
          id: prepared.id,
          treeId: inputs.tree.id,
          branchId,
          parentId: prepared.parentId,
          question: prepared.content,
          content: state.content,
          providerId: prepared.providerId,
          funding: prepared.funding,
          model,
          usage: finalTokenUsage(state.usage),
          sources: state.sources,
          createdAt: this.now(),
        },
      };
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : 'Generation failed' };
    }
  }

  /**
   * Appends a held candidate to its branch as a normal exchange: the question
   * and a complete reply with the candidate's model, provider, usage and
   * sources. The branch's own route and model are not changed. Rejects with
   * ConflictError when the branch moved on since the candidate was asked (its
   * leaf is no longer the candidate's parent) or a reply is streaming.
   * Auto-titles the branch after its first exchange, like a send
   * (`appendCandidate`, then `titleCommitted`).
   */
  async commitCandidate(held: HeldCandidate): Promise<CommitCandidateResponse> {
    const result = await this.appendCandidate(held);
    return { ...result, branch: await this.titleCommitted(result) };
  }

  /**
   * The append half of `commitCandidate`, with no model call: a caller that
   * serializes commits with sends (the Durable Object's send lock) holds the
   * lock for this only, and auto-titles after releasing it.
   */
  async appendCandidate(held: HeldCandidate): Promise<CommitCandidateResponse> {
    const owned = await this.owned.branch(held.branchId);
    const branch = owned.branch;
    if (branch.treeId !== held.treeId) throw new NotFoundError('Branch');
    const leaf = (await this.repo.listBranchNodes(branch.id)).at(-1);
    if (leaf?.status === 'streaming') {
      throw new ConflictError('A reply is still being generated in this branch');
    }
    if ((leaf?.id ?? branch.branchPointNodeId) !== held.parentId) {
      throw new ConflictError('The conversation moved on since you compared; ask again');
    }
    const now = this.now();
    const seq = leaf ? leaf.seq + 1 : 0;
    const userNode: ChatNode = {
      id: this.newId(),
      treeId: branch.treeId,
      branchId: branch.id,
      parentId: held.parentId,
      seq,
      role: 'user',
      content: held.question,
      status: 'complete',
      error: null,
      providerId: null,
      model: null,
      usage: null,
      createdAt: now,
    };
    const assistantNode: ChatNode = {
      id: this.newId(),
      treeId: branch.treeId,
      branchId: branch.id,
      parentId: userNode.id,
      seq: seq + 1,
      role: 'assistant',
      content: held.content,
      status: 'complete',
      error: null,
      providerId: held.providerId,
      model: held.model,
      usage: held.usage,
      sources: held.sources,
      createdAt: now,
    };
    await this.repo.appendNodes([userNode, assistantNode], now);
    return { userNode, assistantNode, branch };
  }

  /**
   * Auto-titles the branch (and the tree, for the trunk) after a committed
   * first exchange, like a send; best-effort, never throws (the exchange is
   * already in the tree). Returns the branch as it now is.
   */
  async titleCommitted(committed: CommitCandidateResponse): Promise<Branch> {
    const { userNode, assistantNode, branch } = committed;
    if (!this.deps.settings.autoTitle || assistantNode.seq !== 1) return branch;
    try {
      const owned = await this.owned.branch(branch.id);
      return (await this.autoTitle(owned.tree, owned.branch, userNode, assistantNode)) ?? branch;
    } catch (err) {
      this.log('auto_title_failed', {
        treeId: branch.treeId,
        branchId: branch.id,
        error: errorText(err),
      });
      return branch;
    }
  }
}

/** Streams a prompt to completion; returns null on provider error, after passing it to `onError`. */
async function collectText(
  provider: LlmProvider,
  model: string,
  prompt: { system: string | null; messages: ChatMessage[] },
  signal: AbortSignal,
  usageTag: UsageTag,
  effort: ReasoningEffort | null,
  onError: (error: ProviderError) => void,
): Promise<string | null> {
  let text = '';
  for await (const event of provider.stream({
    model,
    system: prompt.system,
    messages: prompt.messages,
    maxOutputTokens: auxOutputTokens(provider.capabilities(model)),
    signal,
    usageTag,
    ...(effort !== null ? { reasoning: effort } : {}),
  })) {
    if (event.type === 'delta') text += event.text;
    else if (event.type === 'billing') continue;
    else if (event.type === 'error') {
      onError(event.error);
      return null;
    }
  }
  return text;
}

const SUMMARY_MISSING_STATUS = 'A summary could not be generated; sending without it.';

/**
 * Whether a resolved plan leaves out a summary: one failed or is still
 * pending, or the compaction failed and the oldest messages were dropped.
 */
function missesSummary(plan: ContextPlan): boolean {
  return (
    plan.truncation?.compactionFailed === true ||
    plan.segments.some((s) => s.kind === 'summary' && s.status !== 'ready')
  );
}

/** For providers without a system prompt: fold it into the first user message. */
function foldSystem(prompt: { system: string | null; messages: ChatMessage[] }) {
  const [first, ...rest] = prompt.messages;
  if (prompt.system === null || !first) return prompt;
  return {
    system: null,
    messages: [{ ...first, content: `${prompt.system}\n\n${first.content}` }, ...rest],
  };
}

/**
 * The outcome of a reply the provider finished with `stopReason`: complete,
 * unless it stopped at its output cap (`isLengthStop`; with no text at all, a
 * reasoning model thought until the cap) or wrote nothing. Those are errors
 * with fixed messages (stop-reason.ts) the apps recognize.
 */
function replyOutcome(content: string, stopReason: string | null): ReplyTerminal {
  const empty = content.trim() === '';
  if (isLengthStop(stopReason))
    return { status: 'error', message: empty ? REPLY_THINKING_ONLY_ERROR : REPLY_CUT_OFF_ERROR };
  if (empty) return { status: 'error', message: REPLY_EMPTY_ERROR };
  return { status: 'complete' };
}

/** Accumulated usage as stored: null when the provider reported none. */
function finalTokenUsage(usage: Partial<TokenUsage>): TokenUsage | null {
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined
    ? { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 }
    : null;
}

function stripUndefined(usage: Partial<TokenUsage>): Partial<TokenUsage> {
  const out: Partial<TokenUsage> = {};
  if (usage.inputTokens !== undefined) out.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) out.outputTokens = usage.outputTokens;
  return out;
}
