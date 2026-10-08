import {
  CHECK_SOURCES_INSTRUCTIONS,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_GROUNDING_MODE,
  GROUNDING_INSTRUCTIONS,
  DEFAULT_BRANCH_TITLE_PREFIX,
  DEFAULT_TREE_TITLE,
  LEGACY_BUILT_IN_PROVIDER_ID,
  BUILT_IN_PROVIDER_ID,
  MAX_LINKS_PER_TREE,
  TRUNK_TITLE,
  DEFAULT_REPLY_OUTPUT_TOKENS,
  REASONING_REPLY_OUTPUT_TOKENS,
  REPLY_CANCELLED_ERROR,
  REPLY_CUT_OFF_ERROR,
  REPLY_EMPTY_ERROR,
  REPLY_THINKING_ONLY_ERROR,
  auxOutputTokens,
  isLengthStop,
  replyOutputTokens,
  createBranchRequestSchema,
  createLinkRequestSchema,
  pickDefaultRoute,
  createTreeRequestSchema,
  treeBackupSchema,
  updateBranchRequestSchema,
  updateLinkRequestSchema,
  updateSettingsRequestSchema,
  updateTreeRequestSchema,
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
  type LlmProvider,
  type NodeLink,
  type ProviderCapabilities,
  type ProviderInfo,
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
import {
  buildReviewPrompt,
  buildSummaryPrompt,
  buildTitlePrompt,
  cleanTitle,
  plainText,
  renderPlan,
  type RenderOptions,
} from '../context/render.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import {
  decideGrounding,
  type GroundingDecision,
  type GroundingPolicy,
} from '../grounding/policy.js';
import { adaptBackupForLearn, type LearnImportTarget } from '../learn-import.js';
import { pairKey } from '../links.js';
import type { Repositories } from '../repository.js';
import type { TokenEstimator } from '../tokens.js';
import { newId as defaultNewId, systemClock, type Clock } from '../util.js';

export interface ChatSettings {
  /**
   * Provider/model used for summaries and titles. null provider = use the
   * branch's own provider/model; null model = that provider's default model.
   */
  summaryProviderId: string | null;
  summaryModel: string | null;
  /**
   * Reasoning effort of summaries and titles (`GenerateRequest.reasoning`):
   * short outputs that need little thinking. null = the summary model's own
   * (its configured `ModelInfo.effort`, else the model's default).
   */
  summaryEffort: ReasoningEffort | null;
  /**
   * A reply's output cap (also reserved when computing the input budget) on a
   * model that doesn't reason. Default DEFAULT_REPLY_OUTPUT_TOKENS (4096).
   */
  reservedOutputTokens: number;
  /**
   * The same on a reasoning model (`ProviderCapabilities.reasoning`), whose
   * thinking counts as output. Default REASONING_REPLY_OUTPUT_TOKENS (16384).
   * Either is capped at the model's `maxOutputTokens`.
   */
  reasoningOutputTokens: number;
  /** Optional cap below the provider's context window (e.g. to save cost). */
  maxInputTokens: number | null;
  /** Generate a branch title after the first assistant reply. */
  autoTitle: boolean;
  /** Web-search grounding of replies (docs/DECISIONS.md § Grounding). */
  grounding: GroundingSettings;
}

export interface GroundingSettings {
  /** Operator ceiling over the per-branch setting; see GroundingPolicy. */
  policy: GroundingPolicy;
  /** Results per search. */
  maxResults: number;
  /** Most searches per reply. */
  maxUses: number;
  /** Search engine passed to the provider (OpenRouter: `exa`, …). */
  engine: string;
  /**
   * True when the per-branch setting is ignored and every branch counts as
   * `auto` (Learn: the pedagogy is the operator's, not the learner's).
   */
  ignoreBranchSetting: boolean;
}

export const DEFAULT_GROUNDING_SETTINGS: GroundingSettings = {
  policy: 'off',
  maxResults: 5,
  maxUses: 1,
  engine: 'exa',
  ignoreBranchSetting: false,
};

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  summaryProviderId: null,
  summaryModel: null,
  summaryEffort: null,
  reservedOutputTokens: DEFAULT_REPLY_OUTPUT_TOKENS,
  reasoningOutputTokens: REASONING_REPLY_OUTPUT_TOKENS,
  maxInputTokens: null,
  autoTitle: true,
  grounding: DEFAULT_GROUNDING_SETTINGS,
};

export { DEFAULT_TREE_TITLE, TRUNK_TITLE };
const MAX_RESOLVE_ROUNDS = 4;
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
   * A reservation the caller already made for the reply (the open
   * pool's ceiling hold), passed to the provider as `usageTag.reservationId`.
   */
  reservationId?: string;
  /** `required`: "Check sources", the reply must search (when the provider can). */
  ground?: 'required';
  /**
   * The reply's output cap the caller asks for (power's setting), instead of
   * the settings' default for the model; capped at the model's limit.
   */
  maxOutputTokens?: number;
}

/** A validated review, ready to run (see `prepareReview`). */
export interface PreparedReview {
  node: ChatNode;
  providerId: string;
  funding: BranchFunding;
  model: string;
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
  readonly accountId: string;

  constructor(readonly deps: ChatServiceDeps) {
    this.accountId = deps.accountId ?? DEFAULT_ACCOUNT_ID;
    this.clock = deps.clock ?? systemClock;
    this.newId = deps.newId ?? (() => defaultNewId());
  }

  private get repo() {
    return this.deps.repos.trees;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  // ---------------------------------------------------------------- trees

  listTrees(): Promise<TreeSummary[]> {
    return this.repo.listTrees(this.accountId);
  }

  /**
   * Loads a tree owned by this service's account. Another account's tree is
   * reported as not found. Branch- and node-level entry points go through
   * `getOwnedBranch`/`getOwnedNode`, so every public method is scoped.
   */
  private async requireOwnedTree(treeId: string): Promise<Tree> {
    const tree = await this.repo.getTree(treeId);
    if (!tree || tree.accountId !== this.accountId) throw new NotFoundError('Tree');
    return tree;
  }

  /**
   * Loads a branch whose tree is owned by this service's account. A missing
   * branch, or one in another account's tree, is reported as not found.
   */
  async getOwnedBranch(branchId: string): Promise<Branch> {
    return (await this.requireOwnedBranch(branchId)).branch;
  }

  /** `getOwnedBranch` that also returns the (already loaded) tree. */
  private async requireOwnedBranch(branchId: string): Promise<{ branch: Branch; tree: Tree }> {
    const branch = await this.repo.getBranch(branchId);
    if (!branch) throw new NotFoundError('Branch');
    const tree = await this.repo.getTree(branch.treeId);
    if (!tree || tree.accountId !== this.accountId) throw new NotFoundError('Branch');
    return { branch, tree };
  }

  /**
   * Loads a node whose tree is owned by this service's account. A missing
   * node, or one in another account's tree, is reported as not found.
   */
  async getOwnedNode(nodeId: string): Promise<ChatNode> {
    const node = await this.repo.getNode(nodeId);
    if (!node) throw new NotFoundError('Node');
    const tree = await this.repo.getTree(node.treeId);
    if (!tree || tree.accountId !== this.accountId) throw new NotFoundError('Node');
    return node;
  }

  /**
   * Creates the tree and an empty trunk (on the route the request names, else
   * the default route, `defaultRoute`; the provider's default model unless
   * one is named). Without a system prompt in the request, the tree gets the
   * account's saved default, else the built-in one (`deps.defaultSystemPrompt`).
   */
  async createTree(request: CreateTreeRequest): Promise<TreeDetail> {
    const req = createTreeRequestSchema.parse(request);
    const route = await this.newTreeRoute(req);
    const provider = this.requireProvider(route);
    const model = req.model ?? provider.defaultModel();
    const systemPrompt = emptyToNull(req.systemPrompt) ?? (await this.newTreeSystemPrompt());
    const now = this.now();
    const tree: Tree = {
      id: this.newId(),
      accountId: this.accountId,
      title: req.title ?? DEFAULT_TREE_TITLE,
      systemPrompt,
      trunkBranchId: this.newId(),
      createdAt: now,
      updatedAt: now,
    };
    const trunk: Branch = {
      id: tree.trunkBranchId,
      treeId: tree.id,
      parentBranchId: null,
      branchPointNodeId: null,
      contextMode: 'path',
      anchorQuote: null,
      title: TRUNK_TITLE,
      titleSource: 'default',
      isPrivate: false,
      providerId: route.providerId,
      model,
      grounding: DEFAULT_GROUNDING_MODE,
      funding: route.funding,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.createTree(tree, trunk);
    return { tree, branches: [trunk], nodes: [], links: [] };
  }

  async getTreeDetail(treeId: string): Promise<TreeDetail> {
    const tree = await this.requireOwnedTree(treeId);
    const [branches, nodes, links] = await Promise.all([
      this.repo.listBranches(treeId),
      this.repo.listNodes(treeId),
      this.repo.listLinks(treeId),
    ]);
    return { tree, branches, nodes, links };
  }

  async updateTree(treeId: string, request: UpdateTreeRequest): Promise<Tree> {
    const req = updateTreeRequestSchema.parse(request);
    await this.requireOwnedTree(treeId);
    const patch: Partial<Pick<Tree, 'title' | 'systemPrompt' | 'updatedAt'>> = {
      updatedAt: this.now(),
    };
    if (req.title !== undefined) patch.title = req.title;
    if (req.systemPrompt !== undefined) patch.systemPrompt = emptyToNull(req.systemPrompt);
    const tree = await this.repo.updateTree(treeId, patch);
    if (!tree) throw new NotFoundError('Tree');
    return tree;
  }

  async deleteTree(treeId: string): Promise<void> {
    await this.requireOwnedTree(treeId);
    const deleted = await this.repo.deleteTree(treeId);
    if (!deleted) throw new NotFoundError('Tree');
  }

  // ------------------------------------------------------------- settings

  /** The account's settings, with the built-in default prompt a client can show ("Use default"). */
  async getSettings(): Promise<SettingsResponse> {
    const saved = await this.deps.repos.settings.getSettings(this.accountId);
    return this.settingsResponse(saved?.systemPrompt ?? null);
  }

  /** Saves the account's default system prompt; a blank one means the built-in default (null). */
  async updateSettings(request: UpdateSettingsRequest): Promise<SettingsResponse> {
    const req = updateSettingsRequestSchema.parse(request);
    const systemPrompt = emptyToNull(req.systemPrompt);
    await this.deps.repos.settings.putSettings(this.accountId, { systemPrompt }, this.now());
    return this.settingsResponse(systemPrompt);
  }

  private settingsResponse(systemPrompt: string | null): SettingsResponse {
    return { systemPrompt, defaultSystemPrompt: this.deps.defaultSystemPrompt ?? '' };
  }

  /** The account's saved default prompt, else the built-in one. */
  private async newTreeSystemPrompt(): Promise<string | null> {
    const saved = await this.deps.repos.settings.getSettings(this.accountId);
    return emptyToNull(saved?.systemPrompt) ?? emptyToNull(this.deps.defaultSystemPrompt);
  }

  // ------------------------------------------------------------- branches

  /** New branch hanging off `fromNodeId`; inherits provider/model from the parent branch. */
  async createBranch(request: CreateBranchRequest): Promise<Branch> {
    const req = createBranchRequestSchema.parse(request);
    const node = await this.getOwnedNode(req.fromNodeId);
    const parent = await this.repo.getBranch(node.branchId);
    if (!parent) throw new NotFoundError('Branch');

    const route = this.requestedRoute(req, parent);
    const provider = this.requireProvider(route);
    const model =
      req.model ??
      (route.providerId === parent.providerId ? parent.model : provider.defaultModel());
    const anchorQuote = emptyToNull(req.anchorQuote?.trim());
    const now = this.now();
    const branch: Branch = {
      id: this.newId(),
      treeId: node.treeId,
      parentBranchId: parent.id,
      branchPointNodeId: node.id,
      contextMode: req.contextMode,
      anchorQuote,
      title: req.title ?? defaultBranchTitle(anchorQuote, node),
      titleSource: req.title ? 'user' : 'default',
      isPrivate: req.isPrivate ?? false,
      providerId: route.providerId,
      model,
      grounding: req.grounding ?? parent.grounding ?? DEFAULT_GROUNDING_MODE,
      funding: route.funding,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.createBranch(branch);
    await this.repo.updateTree(branch.treeId, { updatedAt: now });
    return branch;
  }

  async updateBranch(branchId: string, request: UpdateBranchRequest): Promise<Branch> {
    const req = updateBranchRequestSchema.parse(request);
    const branch = await this.getOwnedBranch(branchId);
    const isTrunk = branch.parentBranchId === null;
    if (isTrunk && (req.contextMode !== undefined || req.anchorQuote !== undefined)) {
      throw new ValidationError('The main thread has no context mode or anchor quote');
    }
    const patch: Parameters<Repositories['trees']['updateBranch']>[1] = { updatedAt: this.now() };
    if (req.title !== undefined) {
      patch.title = req.title;
      patch.titleSource = 'user';
    }
    if (req.contextMode !== undefined) patch.contextMode = req.contextMode;
    if (req.anchorQuote !== undefined) patch.anchorQuote = emptyToNull(req.anchorQuote?.trim());
    if (req.isPrivate !== undefined) patch.isPrivate = req.isPrivate;
    if (req.grounding !== undefined) patch.grounding = req.grounding;
    if (req.providerId !== undefined || req.funding !== undefined || req.model !== undefined) {
      const route = this.requestedRoute(req, branch);
      const provider = this.requireProvider(route);
      patch.providerId = route.providerId;
      patch.funding = route.funding;
      patch.model =
        req.model ??
        (route.providerId === branch.providerId ? branch.model : provider.defaultModel());
    }
    const updated = await this.repo.updateBranch(branchId, patch);
    if (!updated) throw new NotFoundError('Branch');
    return updated;
  }

  /**
   * Deletes a branch with every branch below it: child branches hang off
   * its messages, so they cannot outlive it. Their messages, the links
   * touching them, the summaries anchored on them and the shares targeting
   * them go too. The trunk cannot be deleted (delete the tree instead).
   *
   * Without `stopGenerations` it rejects with ConflictError while any of
   * those branches is generating. With it, the caller (the Worker's Durable
   * Object, which owns generations) is handed the doomed branch ids to stop
   * its runs first, and leftover `streaming` nodes are deleted as orphans.
   */
  async deleteBranch(
    branchId: string,
    options: { stopGenerations?: (branchIds: ReadonlySet<string>) => Promise<void> } = {},
  ): Promise<DeleteBranchResponse> {
    const { branch, tree } = await this.requireOwnedBranch(branchId);
    if (branch.parentBranchId === null || branch.id === tree.trunkBranchId) {
      throw new ValidationError(
        'The main thread cannot be deleted; delete the conversation instead',
      );
    }

    const all = await this.repo.listBranches(tree.id);
    const branchIds = subtreeBranchIds(all, branch.id);
    const doomed = new Set(branchIds);
    if (options.stopGenerations) {
      await options.stopGenerations(doomed);
    } else {
      const streaming = await this.repo.listStreamingNodes(tree.id);
      if (streaming.some((n) => doomed.has(n.branchId))) {
        throw new ConflictError('A reply is still being generated in this branch; stop it first');
      }
    }
    const nodeIds = (await this.repo.listNodes(tree.id))
      .filter((n) => doomed.has(n.branchId))
      .map((n) => n.id);
    await this.repo.deleteBranches(tree.id, branchIds, this.now());
    return { treeId: tree.id, branchIds, nodeIds };
  }

  // ---------------------------------------------------------------- links

  /**
   * Links two messages of the same tree (both must be this account's: 404
   * otherwise). Linking a pair that is already linked, either way round,
   * changes nothing and returns the existing link with `created: false`.
   * Never generates, so read-only power branches can be linked too.
   */
  async createLink(request: CreateLinkRequest): Promise<{ link: NodeLink; created: boolean }> {
    const req = createLinkRequestSchema.parse(request);
    const from = await this.getOwnedNode(req.fromNodeId);
    const to = await this.getOwnedNode(req.toNodeId);
    if (from.treeId !== to.treeId) {
      throw new ValidationError('Only messages of the same conversation can be linked');
    }
    const links = await this.repo.listLinks(from.treeId);
    const key = pairKey(from.id, to.id);
    const existing = links.find((l) => pairKey(l.sourceNodeId, l.targetNodeId) === key);
    if (existing) return { link: existing, created: false };
    if (links.length >= MAX_LINKS_PER_TREE) {
      throw new ValidationError(
        `A conversation can hold at most ${MAX_LINKS_PER_TREE} links; remove one first`,
      );
    }
    const now = this.now();
    return this.repo.createLink(
      {
        id: this.newId(),
        treeId: from.treeId,
        sourceNodeId: from.id,
        targetNodeId: to.id,
        note: emptyToNull(req.note),
        origin: 'user',
        createdAt: now,
        updatedAt: now,
      },
      now,
    );
  }

  /** Changes a link's note (blank = none). */
  async updateLink(linkId: string, request: UpdateLinkRequest): Promise<NodeLink> {
    const req = updateLinkRequestSchema.parse(request);
    await this.requireOwnedLink(linkId);
    const updated = await this.repo.updateLink(linkId, {
      note: emptyToNull(req.note),
      updatedAt: this.now(),
    });
    if (!updated) throw new NotFoundError('Link');
    return updated;
  }

  async deleteLink(linkId: string): Promise<void> {
    await this.requireOwnedLink(linkId);
    if (!(await this.repo.deleteLink(linkId))) throw new NotFoundError('Link');
  }

  /** A link in a tree of this account; another account's link is reported as not found. */
  private async requireOwnedLink(linkId: string): Promise<NodeLink> {
    const link = await this.repo.getLink(linkId);
    if (!link) throw new NotFoundError('Link');
    const tree = await this.repo.getTree(link.treeId);
    if (!tree || tree.accountId !== this.accountId) throw new NotFoundError('Link');
    return link;
  }

  // -------------------------------------------------------------- context

  /**
   * Plans the context for replying at `nodeId` (default: branch leaf). With
   * `resolveSummaries`, missing summaries are generated (and cached) first.
   */
  async planContext(
    branchId: string,
    nodeId: string | null,
    options: { resolveSummaries: boolean; signal?: AbortSignal },
  ): Promise<ContextPlanResponse> {
    const inputs = await this.loadPlanInputs(branchId, nodeId);
    const steps = this.resolvePlan(inputs, options.resolveSummaries, options.signal);
    let step = await steps.next();
    while (!step.done) step = await steps.next();
    const plan = step.value;
    const model = this.modelOf(inputs.branch);
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
      } catch {
        exactInputTokens = null;
      }
    }
    return {
      plan,
      rendered,
      providerId: inputs.branch.providerId,
      funding: this.fundingOf(inputs.branch),
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
    const owned = await this.requireOwnedBranch(branchId);
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
    const provider = this.requireProvider(branch);
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

  /** With a locked system prompt, anchor quotes stay out of the system channel. */
  private renderOptions(supportsSystemPrompt: boolean): RenderOptions {
    return {
      supportsSystemPrompt,
      anchorsAsUserText: this.deps.systemPromptOverride !== undefined,
    };
  }

  /** The model generations on `branch` use: the pinned one, else the branch's. */
  private modelOf(branch: Branch): string {
    return this.deps.pinnedModel ?? branch.model;
  }

  /**
   * A reply's output cap on `model` (`requested`, else the settings' default
   * for a reasoning or a plain model, within the model's limit) and the input
   * budget that leaves in its context window.
   */
  private budgetFor(
    provider: LlmProvider,
    model: string,
    requested?: number,
  ): { maxInputTokens: number; maxOutput: number } {
    const caps = provider.capabilities(model);
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
    return { maxInputTokens, maxOutput };
  }

  private summaryTarget(branch: Branch): { provider: LlmProvider; model: string } {
    const { summaryProviderId, summaryModel } = this.deps.settings;
    if (summaryProviderId) {
      // A configured summary provider is an own-key route (never credit, in power).
      const provider = this.deps.providers.get(summaryProviderId);
      if (provider) return { provider, model: summaryModel ?? provider.defaultModel() };
    }
    // No (usable) summary provider configured: summarize on the branch's own route and model.
    return { provider: this.requireProvider(branch), model: this.modelOf(branch) };
  }

  /**
   * Plan → (cache lookup | generate) missing summaries → re-plan, until the
   * plan is complete, nothing changes, or MAX_RESOLVE_ROUNDS is reached.
   * Yields human-readable status messages; returns the final plan.
   */
  private async *resolvePlan(
    inputs: PlanInputs,
    generate: boolean,
    signal?: AbortSignal,
    requestedOutput?: number,
  ): AsyncGenerator<string, ContextPlan> {
    const summaries = new Map<string, string>();
    const failed = new Set<string>();
    const { provider: summaryProvider, model: summaryModel } = this.summaryTarget(
      inputs.summaryBranch,
    );
    const { maxInputTokens } = this.budgetFor(
      inputs.provider,
      this.modelOf(inputs.branch),
      requestedOutput,
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
        budget: { maxInputTokens },
        ...(this.deps.inputBound ? { estimateTokens: this.deps.inputBound.estimateTokens } : {}),
      });

    let current = plan();
    for (let round = 0; round < MAX_RESOLVE_ROUNDS; round++) {
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

      // 2. Generate what is still missing.
      for (const request of current.pendingSummaries) {
        const k = summaryKeyString(request.key);
        if (summaries.has(k) || failed.has(k)) continue;
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
    return current;
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
        maxInputTokens: this.budgetFor(provider, model).maxInputTokens,
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
    this.requireProvider(branch);
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
      model: this.modelOf(branch),
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
      const steps = this.resolvePlan(inputs, true, signal, options.maxOutputTokens);
      let step = await steps.next();
      while (!step.done) {
        yield { type: 'status', message: step.value };
        step = await steps.next();
      }
      const plan = step.value;
      if (plan.segments.some((s) => s.kind === 'summary' && s.status === 'failed')) {
        yield {
          type: 'status',
          message: 'A summary could not be generated; sending without it.',
        };
      }
      const model = this.modelOf(branch);
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
      } catch {
        node = null;
      }
      yield { type: 'error', nodeId: assistantNode.id, message, node };
    }
  }

  /**
   * Streams one reply to a planned context: renders it (with the grounding
   * instructions when a search is offered), yields `delta`/`usage` for
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
    const { maxOutput } = this.budgetFor(provider, model, target.maxOutputTokens);
    let terminal: ReplyTerminal | null = null;
    let webSearch = this.webSearchRequest(target.grounding);
    for (let attempt = 0; attempt < 2; attempt++) {
      let retryWithoutSearch = false;
      const extraSystem =
        webSearch === undefined
          ? undefined
          : webSearch.mode === 'required'
            ? CHECK_SOURCES_INSTRUCTIONS
            : GROUNDING_INSTRUCTIONS;
      const rendered = renderPlan(plan, {
        ...this.renderOptions(caps.supportsSystemPrompt),
        ...(extraSystem !== undefined ? { extraSystem } : {}),
      });
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
      return this.requireProvider(branch).capabilities(this.modelOf(branch)).supportsWebSearch;
    } catch {
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
    let allowed: boolean;
    try {
      allowed = await this.deps.groundingAllowance({
        providerId: inputs.branch.providerId,
        funding: inputs.branch.funding,
      });
    } catch {
      allowed = false;
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
      const { provider, model } = this.summaryTarget(branch);
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
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------- reviews

  /**
   * Validates a review of the conversation up to `nodeId` before any stream
   * opens, so bad requests fail as plain HTTP errors. Only finished
   * assistant replies can be reviewed.
   */
  async prepareReview(nodeId: string, request: ReviewRequest): Promise<PreparedReview> {
    const node = await this.getOwnedNode(nodeId);
    if (node.role !== 'assistant')
      throw new ValidationError('Only assistant replies can be reviewed');
    if (node.status !== 'complete') throw new ValidationError('That reply has not finished');
    const route = this.requestedRoute(request, null);
    this.requireProvider(route);
    return { node, ...route, model: request.model };
  }

  /**
   * Streams a review. The reviewer gets the context exactly as the branch's
   * model rendered it for this reply (summaries resolved and cached like a
   * normal send), followed by the reply itself. Nothing is persisted.
   * Never throws; ends with exactly one `done` or `error`.
   */
  async *runReview(review: PreparedReview, signal: AbortSignal): AsyncIterable<ReviewEvent> {
    try {
      const inputs = await this.loadPlanInputs(review.node.branchId, review.node.id);
      const steps = this.resolvePlan(inputs, true, signal);
      let step = await steps.next();
      while (!step.done) {
        yield { type: 'status', message: step.value };
        step = await steps.next();
      }
      const caps = inputs.provider.capabilities(this.modelOf(inputs.branch));
      const context = renderPlan(step.value, this.renderOptions(caps.supportsSystemPrompt));
      const reviewer = this.requireProvider(review);
      const prompt = buildReviewPrompt(context, review.node.model);
      const rendered = reviewer.capabilities(review.model).supportsSystemPrompt
        ? prompt
        : foldSystem(prompt);
      const { maxOutput } = this.budgetFor(reviewer, review.model);
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
  async prepareCandidate(branchId: string, request: CandidateRequest): Promise<PreparedCandidate> {
    const branch = await this.getOwnedBranch(branchId);
    if (!request.content.trim()) throw new ValidationError('Message is empty');
    const leaf = (await this.repo.listBranchNodes(branchId)).at(-1);
    if (leaf?.status === 'streaming') {
      throw new ConflictError('A reply is still being generated in this branch');
    }
    const route = this.requestedRoute(request, branch);
    this.requireProvider(route);
    return {
      id: this.newId(),
      branch,
      parentId: leaf?.id ?? branch.branchPointNodeId,
      content: request.content,
      ...route,
      model: request.model,
    };
  }

  /**
   * Streams a candidate reply: the context is planned as if the question had
   * been sent (summaries resolved and cached like a normal send) on the
   * candidate's route and model, and the reply streams exactly as
   * `runGeneration` would stream it (grounding included), metered as a
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
      const steps = this.resolvePlan(inputs, true, signal);
      let step = await steps.next();
      while (!step.done) {
        yield { type: 'status', message: step.value };
        step = await steps.next();
      }
      const plan = step.value;
      if (plan.segments.some((s) => s.kind === 'summary' && s.status === 'failed')) {
        yield { type: 'status', message: 'A summary could not be generated; sending without it.' };
      }
      const model = this.modelOf(inputs.branch);
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
    const owned = await this.requireOwnedBranch(held.branchId);
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
      const owned = await this.requireOwnedBranch(branch.id);
      return (await this.autoTitle(owned.tree, owned.branch, userNode, assistantNode)) ?? branch;
    } catch {
      return branch;
    }
  }

  /** Marks leftover `streaming` nodes of a tree as `error` ("interrupted"). */
  async recoverInterrupted(treeId: string): Promise<number> {
    const stale = await this.repo.listStreamingNodes(treeId);
    for (const node of stale) {
      await this.repo.updateNode(node.id, {
        status: 'error',
        error: 'Interrupted before the reply finished',
      });
    }
    return stale.length;
  }

  // --------------------------------------------------------------- backup

  async exportBackup(treeId: string): Promise<TreeBackup> {
    const detail = await this.getTreeDetail(treeId);
    return {
      format: 'tangent-tree-backup',
      version: 1,
      exportedAt: this.now(),
      tree: detail.tree,
      branches: detail.branches,
      nodes: detail.nodes,
      links: detail.links,
    };
  }

  /**
   * Restores a backup under fresh ids, in this instance's account. Learn
   * (`adaptImportsForLearn`) first adapts it to what Learn can run.
   */
  async importBackup(backup: TreeBackup | TreeBackupInput): Promise<TreeDetail> {
    const parsed = treeBackupSchema.parse(backup);
    const data = this.deps.adaptImportsForLearn
      ? adaptBackupForLearn(parsed, await this.learnImportTarget())
      : parsed;
    const branchIds = new Map(data.branches.map((b) => [b.id, this.newId()] as const));
    const nodeIds = new Map(data.nodes.map((n) => [n.id, this.newId()] as const));
    const mapBranch = (id: string): string => {
      const mapped = branchIds.get(id);
      if (!mapped) throw new ValidationError(`Backup references unknown branch ${id}`);
      return mapped;
    };
    const mapNode = (id: string): string => {
      const mapped = nodeIds.get(id);
      if (!mapped) throw new ValidationError(`Backup references unknown node ${id}`);
      return mapped;
    };
    const trunks = data.branches.filter((b) => b.parentBranchId === null);
    if (trunks.length !== 1 || trunks[0]?.id !== data.tree.trunkBranchId) {
      throw new ValidationError('Backup must contain exactly one trunk branch');
    }
    const treeId = this.newId();
    const now = this.now();
    const { accountId: _ignored, ...backupTree } = data.tree;
    const tree: Tree = {
      ...backupTree,
      id: treeId,
      accountId: this.accountId,
      trunkBranchId: mapBranch(data.tree.trunkBranchId),
      updatedAt: now,
    };
    const branches: Branch[] = data.branches.map((b) => ({
      ...b,
      id: mapBranch(b.id),
      treeId,
      parentBranchId: b.parentBranchId === null ? null : mapBranch(b.parentBranchId),
      branchPointNodeId: b.branchPointNodeId === null ? null : mapNode(b.branchPointNodeId),
      ...importedRoute(b, this.deps.fixedFunding),
    }));
    const nodes: ChatNode[] = data.nodes.map((n) => ({
      ...n,
      providerId:
        n.providerId === LEGACY_BUILT_IN_PROVIDER_ID ? BUILT_IN_PROVIDER_ID : n.providerId,
      id: mapNode(n.id),
      treeId,
      branchId: mapBranch(n.branchId),
      parentId: n.parentId === null ? null : mapNode(n.parentId),
      status: n.status === 'streaming' ? 'error' : n.status,
      error: n.status === 'streaming' ? 'Interrupted before the reply finished' : n.error,
    }));
    const links = importedLinks(data.links ?? [], nodeIds, treeId, this.newId);
    await this.repo.importTree(tree, branches, nodes, links);
    return { tree, branches, nodes, links };
  }

  // -------------------------------------------------------------- helpers

  /** What Learn adapts an import to: its one provider and models, and a new tree's prompt. */
  private async learnImportTarget(): Promise<LearnImportTarget> {
    const providers = this.deps.providers;
    const provider = providers.get(providers.defaultProviderId());
    if (!provider) throw new ValidationError('There is no provider to import onto');
    return {
      providerId: provider.id,
      models: provider.models().map((m) => m.id),
      defaultModel: provider.defaultModel(),
      systemPrompt: await this.newTreeSystemPrompt(),
    };
  }

  /** How calls on `branch` are paid as far as this instance knows: Learn's fixed funding, else the branch's. */
  private fundingOf(branch: Pick<Branch, 'funding'>): BranchFunding {
    return this.deps.fixedFunding ?? branch.funding;
  }

  /**
   * The route a request names, completed from `base` (the parent branch, or
   * the branch being changed): nothing named keeps `base`'s route; a provider
   * without a funding is on the user's own key, so naming a provider never
   * spends credit implicitly; a funding without a provider keeps `base`'s
   * provider. Without a `base` (a reviewer) a provider must be named; a new
   * tree that names none gets the default route (`newTreeRoute`). Learn's
   * fixed funding always wins.
   */
  private requestedRoute(
    req: { providerId?: string | undefined; funding?: BranchFunding | undefined },
    base: Pick<Branch, 'providerId' | 'funding'> | null,
  ): ProviderRoute {
    let route: ProviderRoute;
    if (req.providerId !== undefined) {
      route = { providerId: req.providerId, funding: req.funding ?? 'own-key' };
    } else if (base) {
      route = { providerId: base.providerId, funding: req.funding ?? base.funding };
    } else {
      throw new ValidationError('Name a provider');
    }
    return this.withFixedFunding(route);
  }

  private withFixedFunding(route: ProviderRoute): ProviderRoute {
    const fixed = this.deps.fixedFunding;
    return fixed === undefined ? route : { ...route, funding: fixed };
  }

  /** The trunk route of a new tree: the one the request names, else the default route. */
  private async newTreeRoute(req: {
    providerId?: string | undefined;
    funding?: BranchFunding | undefined;
  }): Promise<ProviderRoute> {
    if (req.providerId !== undefined) return this.requestedRoute(req, null);
    return this.withFixedFunding(await this.defaultRoute(req.funding));
  }

  /**
   * The route of a new tree that names no provider (docs/DECISIONS.md
   * "Default route of a new tree"): `pickDefaultRoute` over the own-key
   * providers and, where it is offered and nothing named a funding, Tangent
   * credit, with what `deps.defaultRouteFacts` says about the balance and the
   * membership (asked only then; without it, credit is never the default).
   * Naming only `credit` picks the credit registry's default provider;
   * naming only `own-key` leaves credit out.
   */
  private async defaultRoute(funding: BranchFunding | undefined): Promise<ProviderRoute> {
    const own = this.deps.providers;
    const credit = this.deps.fixedFunding === undefined ? this.deps.creditProviders : undefined;
    // Credit asked for where it isn't offered: `requireProvider` refuses the route.
    if (funding === 'credit') return { providerId: (credit ?? own).defaultProviderId(), funding };
    const withCredit = funding === undefined && credit !== undefined;
    const entries: ProviderInfo[] = [
      ...own.list().map((p) => ({ ...p, funding: 'own-key' as const })),
      ...(withCredit ? credit.list().map((p) => ({ ...p, funding: 'credit' as const })) : []),
    ];
    const facts: DefaultRouteFacts = (withCredit && (await this.deps.defaultRouteFacts?.())) || {
      creditCanPay: false,
      creditBuyable: false,
      ownKeyLocked: false,
    };
    const picked = pickDefaultRoute(entries, facts);
    if (!picked) return { providerId: own.defaultProviderId(), funding: 'own-key' };
    return { providerId: picked.id, funding: picked.funding ?? 'own-key' };
  }

  /** The provider of a route (a branch, or a requested route); Learn's routes all come from `providers`. */
  private requireProvider(route: Pick<Branch, 'providerId' | 'funding'>): LlmProvider {
    const funding = this.fundingOf(route);
    const registry =
      this.deps.fixedFunding !== undefined || funding === 'own-key'
        ? this.deps.providers
        : this.deps.creditProviders;
    const provider = registry?.get(route.providerId);
    if (!provider) {
      throw new ValidationError(
        funding === 'credit' && this.deps.fixedFunding === undefined
          ? `Unknown provider "${route.providerId}" on Tangent credit`
          : `Unknown provider "${route.providerId}"`,
      );
    }
    return provider;
  }
}

/**
 * A backed-up branch's route as import stores it. Backups name the endpoint
 * and, since funding was split from the provider, the funding. An older
 * backup names neither the funding nor what its legacy `tangent` id was paid
 * with (credit in power, per request in Learn), so a missing funding is
 * `own-key`: an imported conversation never spends credit until its owner
 * picks Tangent credit for it. Learn's fixed funding wins, as for any write.
 */
function importedRoute(
  b: { providerId: string; funding?: BranchFunding | undefined },
  fixedFunding: BranchFunding | undefined,
): ProviderRoute {
  const providerId =
    b.providerId === LEGACY_BUILT_IN_PROVIDER_ID ? BUILT_IN_PROVIDER_ID : b.providerId;
  return { providerId, funding: fixedFunding ?? b.funding ?? 'own-key' };
}

/**
 * A backup's links under the restored node ids. A link whose ends aren't
 * both in the backup, a self-link and a second link between the same pair
 * are dropped rather than failing the import: they are only cross-references.
 */
function importedLinks(
  links: NonNullable<TreeBackupInput['links']>,
  nodeIds: ReadonlyMap<string, string>,
  treeId: string,
  newId: () => string,
): NodeLink[] {
  const out: NodeLink[] = [];
  const pairs = new Set<string>();
  for (const l of links) {
    const source = nodeIds.get(l.sourceNodeId);
    const target = nodeIds.get(l.targetNodeId);
    if (!source || !target || source === target) continue;
    const key = pairKey(source, target);
    if (pairs.has(key)) continue;
    pairs.add(key);
    out.push({
      id: newId(),
      treeId,
      sourceNodeId: source,
      targetNodeId: target,
      note: emptyToNull(l.note?.trim()),
      origin: l.origin ?? 'user',
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    });
  }
  return out;
}

/** Streams a prompt to completion; returns null on provider error. */
async function collectText(
  provider: LlmProvider,
  model: string,
  prompt: { system: string | null; messages: ChatMessage[] },
  signal: AbortSignal,
  usageTag: UsageTag,
  effort: ReasoningEffort | null,
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
    else if (event.type === 'error') return null;
  }
  return text;
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

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === '' ? null : value;
}

/** Accumulated usage as stored: null when the provider reported none. */
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

/** `rootId` first, then its descendants breadth-first (via parentBranchId). */
function subtreeBranchIds(branches: readonly Branch[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const b of branches) {
    if (b.parentBranchId === null) continue;
    const list = children.get(b.parentBranchId);
    if (list) list.push(b.id);
    else children.set(b.parentBranchId, [b.id]);
  }
  const out = [rootId];
  for (let i = 0; i < out.length; i++) {
    const id = out[i];
    if (id !== undefined) out.push(...(children.get(id) ?? []));
  }
  return out;
}

function defaultBranchTitle(anchorQuote: string | null, node: ChatNode): string {
  // A quote is plain text already; a message is Markdown ("**a confident kitten**").
  const source = anchorQuote ? anchorQuote.replace(/\s+/g, ' ').trim() : plainText(node.content);
  if (!source) return 'New branch';
  const words = source.split(' ').slice(0, 6).join(' ');
  const clipped = words.length > 48 ? `${words.slice(0, 47)}…` : words;
  return anchorQuote ? clipped : `${DEFAULT_BRANCH_TITLE_PREFIX}${clipped}`;
}
