import {
  createBranchRequestSchema,
  createTreeRequestSchema,
  treeBackupSchema,
  updateBranchRequestSchema,
  updateTreeRequestSchema,
  type Branch,
  type ChatMessage,
  type ChatNode,
  type ContextPlan,
  type ContextPlanResponse,
  type CreateBranchRequest,
  type CreateTreeRequest,
  type LlmProvider,
  type ProviderRegistry,
  type StreamEvent,
  type SummaryRequest,
  type TokenUsage,
  type Tree,
  type TreeBackup,
  type TreeDetail,
  type TreeSummary,
  type UpdateBranchRequest,
  type UpdateTreeRequest,
} from '@tangent/shared';
import { assembleContext, summaryKeyString } from '../context/assemble.js';
import { buildSummaryPrompt, buildTitlePrompt, cleanTitle, renderPlan } from '../context/render.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import type { Repositories } from '../repository.js';
import { newId as defaultNewId, systemClock, type Clock } from '../util.js';

export interface ChatSettings {
  /**
   * Provider/model used for summaries and titles. null provider = use the
   * branch's own provider/model; null model = that provider's default model.
   */
  summaryProviderId: string | null;
  summaryModel: string | null;
  /** Output tokens reserved when computing the input budget. Default 4096. */
  reservedOutputTokens: number;
  /** Optional cap below the provider's context window (e.g. to save cost). */
  maxInputTokens: number | null;
  /** Generate a branch title after the first assistant reply. */
  autoTitle: boolean;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  summaryProviderId: null,
  summaryModel: null,
  reservedOutputTokens: 4096,
  maxInputTokens: null,
  autoTitle: true,
};

export const DEFAULT_TREE_TITLE = 'New conversation';
export const TRUNK_TITLE = 'Main thread';
const MAX_RESOLVE_ROUNDS = 4;
const TITLE_TIMEOUT_MS = 15_000;

export interface ChatServiceDeps {
  repos: Repositories;
  providers: ProviderRegistry;
  settings: ChatSettings;
  clock?: Clock;
  newId?: () => string;
}

export interface BeginSendResult {
  branch: Branch;
  userNode: ChatNode;
  assistantNode: ChatNode;
}

interface PlanInputs {
  tree: Tree;
  chain: Branch[];
  path: ChatNode[];
  branch: Branch;
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

  constructor(readonly deps: ChatServiceDeps) {
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
    return this.repo.listTrees();
  }

  /** Creates the tree and an empty trunk (provider/model default from the registry). */
  async createTree(request: CreateTreeRequest): Promise<TreeDetail> {
    const req = createTreeRequestSchema.parse(request);
    const providerId = req.providerId ?? this.deps.providers.defaultProviderId();
    const provider = this.requireProvider(providerId);
    const model = req.model ?? provider.defaultModel();
    const now = this.now();
    const tree: Tree = {
      id: this.newId(),
      title: req.title ?? DEFAULT_TREE_TITLE,
      systemPrompt: emptyToNull(req.systemPrompt),
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
      providerId,
      model,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.createTree(tree, trunk);
    return { tree, branches: [trunk], nodes: [] };
  }

  async getTreeDetail(treeId: string): Promise<TreeDetail> {
    const tree = await this.repo.getTree(treeId);
    if (!tree) throw new NotFoundError('Tree');
    const [branches, nodes] = await Promise.all([
      this.repo.listBranches(treeId),
      this.repo.listNodes(treeId),
    ]);
    return { tree, branches, nodes };
  }

  async updateTree(treeId: string, request: UpdateTreeRequest): Promise<Tree> {
    const req = updateTreeRequestSchema.parse(request);
    const patch: Partial<Pick<Tree, 'title' | 'systemPrompt' | 'updatedAt'>> = { updatedAt: this.now() };
    if (req.title !== undefined) patch.title = req.title;
    if (req.systemPrompt !== undefined) patch.systemPrompt = emptyToNull(req.systemPrompt);
    const tree = await this.repo.updateTree(treeId, patch);
    if (!tree) throw new NotFoundError('Tree');
    return tree;
  }

  async deleteTree(treeId: string): Promise<void> {
    const deleted = await this.repo.deleteTree(treeId);
    if (!deleted) throw new NotFoundError('Tree');
  }

  // ------------------------------------------------------------- branches

  /** New branch hanging off `fromNodeId`; inherits provider/model from the parent branch. */
  async createBranch(request: CreateBranchRequest): Promise<Branch> {
    const req = createBranchRequestSchema.parse(request);
    const node = await this.repo.getNode(req.fromNodeId);
    if (!node) throw new NotFoundError('Node');
    const parent = await this.repo.getBranch(node.branchId);
    if (!parent) throw new NotFoundError('Branch');

    const providerId = req.providerId ?? parent.providerId;
    const provider = this.requireProvider(providerId);
    const model =
      req.model ?? (providerId === parent.providerId ? parent.model : provider.defaultModel());
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
      providerId,
      model,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.createBranch(branch);
    await this.repo.updateTree(branch.treeId, { updatedAt: now });
    return branch;
  }

  async updateBranch(branchId: string, request: UpdateBranchRequest): Promise<Branch> {
    const req = updateBranchRequestSchema.parse(request);
    const branch = await this.repo.getBranch(branchId);
    if (!branch) throw new NotFoundError('Branch');
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
    if (req.providerId !== undefined || req.model !== undefined) {
      const providerId = req.providerId ?? branch.providerId;
      const provider = this.requireProvider(providerId);
      patch.providerId = providerId;
      patch.model =
        req.model ?? (providerId === branch.providerId ? branch.model : provider.defaultModel());
    }
    const updated = await this.repo.updateBranch(branchId, patch);
    if (!updated) throw new NotFoundError('Branch');
    return updated;
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
    const caps = inputs.provider.capabilities(inputs.branch.model);
    const rendered = renderPlan(plan, { supportsSystemPrompt: caps.supportsSystemPrompt });
    let exactInputTokens: number | null = null;
    if (caps.supportsTokenCount && inputs.provider.countTokens && rendered.messages.length > 0) {
      try {
        exactInputTokens = await inputs.provider.countTokens({
          model: inputs.branch.model,
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
      model: inputs.branch.model,
      exactInputTokens,
    };
  }

  private async loadPlanInputs(branchId: string, nodeId: string | null): Promise<PlanInputs> {
    const branch = await this.repo.getBranch(branchId);
    if (!branch) throw new NotFoundError('Branch');
    const [tree, chain] = await Promise.all([
      this.repo.getTree(branch.treeId),
      this.repo.getBranchChain(branchId),
    ]);
    if (!tree) throw new NotFoundError('Tree');

    let path: ChatNode[];
    if (nodeId) {
      const node = await this.repo.getNode(nodeId);
      if (!node || node.branchId !== branchId) throw new ValidationError('Node is not in this branch');
      path = await this.repo.getAncestorPath(nodeId);
    } else {
      const own = await this.repo.listBranchNodes(branchId);
      const leaf = own.at(-1);
      const tail = leaf?.id ?? branch.branchPointNodeId;
      path = tail ? await this.repo.getAncestorPath(tail) : [];
    }
    const provider = this.requireProvider(branch.providerId);
    return { tree, chain, path, branch, targetNodeId: nodeId, provider };
  }

  private budgetFor(provider: LlmProvider, model: string): { maxInputTokens: number; maxOutput: number } {
    const caps = provider.capabilities(model);
    const maxOutput = Math.min(this.deps.settings.reservedOutputTokens, caps.maxOutputTokens);
    let maxInputTokens = Math.max(1, caps.maxContextTokens - maxOutput);
    if (this.deps.settings.maxInputTokens !== null) {
      maxInputTokens = Math.min(maxInputTokens, this.deps.settings.maxInputTokens);
    }
    return { maxInputTokens, maxOutput };
  }

  private summaryTarget(branch: Branch): { provider: LlmProvider; model: string } {
    const { summaryProviderId, summaryModel } = this.deps.settings;
    if (summaryProviderId) {
      const provider = this.deps.providers.get(summaryProviderId);
      if (provider) return { provider, model: summaryModel ?? provider.defaultModel() };
    }
    // No (usable) summary provider configured: summarize with the branch's own model.
    return { provider: this.requireProvider(branch.providerId), model: branch.model };
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
  ): AsyncGenerator<string, ContextPlan> {
    const summaries = new Map<string, string>();
    const failed = new Set<string>();
    const { provider: summaryProvider, model: summaryModel } = this.summaryTarget(inputs.branch);
    const { maxInputTokens } = this.budgetFor(inputs.provider, inputs.branch.model);
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
      });

    let current = plan();
    for (let round = 0; round < MAX_RESOLVE_ROUNDS; round++) {
      // 1. Cache lookups for every pending summary we haven't looked up yet.
      // Requests can name inner summaries that have no segment of their own
      // (nested summary modes), so check both.
      let progressed = false;
      const keys = [
        ...current.segments.flatMap((s) => (s.kind === 'summary' && s.status === 'pending' ? [s.key] : [])),
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
        const text = await this.generateSummary(summaryProvider, summaryModel, request, signal);
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
    signal?: AbortSignal,
  ): Promise<string | null> {
    const prompt = buildSummaryPrompt(request);
    const text = await collectText(provider, model, prompt, signal ?? new AbortController().signal);
    return text?.trim() ? text.trim() : null;
  }

  // ------------------------------------------------------------ messages

  /**
   * Appends a user node to the branch leaf (or the branch point for an empty
   * branch) and a `streaming` assistant node after it, atomically.
   * Rejects with ConflictError if the branch leaf is still streaming.
   */
  async beginSend(branchId: string, content: string): Promise<BeginSendResult> {
    const branch = await this.repo.getBranch(branchId);
    if (!branch) throw new NotFoundError('Branch');
    if (!content.trim()) throw new ValidationError('Message is empty');
    this.requireProvider(branch.providerId);
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
      model: branch.model,
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
   */
  async *runGeneration(begin: BeginSendResult, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const { assistantNode, userNode } = begin;
    let branch = begin.branch;
    let content = '';
    const usage: Partial<TokenUsage> = {};
    const finish = async (status: 'complete' | 'error', error: string | null): Promise<ChatNode> => {
      const finalUsage: TokenUsage | null =
        usage.inputTokens !== undefined || usage.outputTokens !== undefined
          ? { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 }
          : null;
      const node: ChatNode = { ...assistantNode, content, status, error, usage: finalUsage };
      await this.repo.updateNode(assistantNode.id, { content, status, error, usage: finalUsage });
      return node;
    };

    try {
      const inputs = await this.loadPlanInputs(branch.id, userNode.id);
      branch = inputs.branch;
      const steps = this.resolvePlan(inputs, true, signal);
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
      const caps = inputs.provider.capabilities(branch.model);
      const rendered = renderPlan(plan, { supportsSystemPrompt: caps.supportsSystemPrompt });
      const { maxOutput } = this.budgetFor(inputs.provider, branch.model);

      let terminal: { status: 'complete' } | { status: 'error'; message: string } | null = null;
      for await (const event of inputs.provider.stream({
        model: branch.model,
        system: rendered.system,
        messages: rendered.messages,
        maxOutputTokens: maxOutput,
        signal,
      })) {
        if (event.type === 'delta') {
          content += event.text;
          yield { type: 'delta', nodeId: assistantNode.id, text: event.text };
        } else if (event.type === 'usage') {
          Object.assign(usage, stripUndefined(event.usage));
          yield { type: 'usage', nodeId: assistantNode.id, usage: event.usage };
        } else if (event.type === 'done') {
          terminal = { status: 'complete' };
        } else {
          terminal = {
            status: 'error',
            message: event.error.code === 'aborted' ? 'Cancelled' : event.error.message,
          };
        }
      }
      terminal ??= { status: 'error', message: 'The provider stream ended unexpectedly' };

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
      const messages: ChatMessage[] = [];
      if (branch.anchorQuote) messages.push({ role: 'user', content: `Focus: ${branch.anchorQuote}` });
      messages.push({ role: 'user', content: userNode.content });
      messages.push({ role: 'assistant', content: assistantNode.content.slice(0, 4000) });
      const raw = await collectText(
        provider,
        model,
        buildTitlePrompt(messages),
        AbortSignal.timeout(TITLE_TIMEOUT_MS),
      );
      const title = raw ? cleanTitle(raw) : null;
      if (!title) return null;
      const now = this.now();
      if (titleTree) await this.repo.updateTree(tree.id, { title, updatedAt: now });
      if (titleBranch) {
        return await this.repo.updateBranch(branch.id, { title, titleSource: 'auto', updatedAt: now });
      }
      return null;
    } catch {
      return null;
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
    };
  }

  /** Restores a backup under fresh ids. */
  async importBackup(backup: TreeBackup): Promise<TreeDetail> {
    const data = treeBackupSchema.parse(backup);
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
    const tree: Tree = {
      ...data.tree,
      id: treeId,
      trunkBranchId: mapBranch(data.tree.trunkBranchId),
      updatedAt: now,
    };
    const branches: Branch[] = data.branches.map((b) => ({
      ...b,
      id: mapBranch(b.id),
      treeId,
      parentBranchId: b.parentBranchId === null ? null : mapBranch(b.parentBranchId),
      branchPointNodeId: b.branchPointNodeId === null ? null : mapNode(b.branchPointNodeId),
    }));
    const nodes: ChatNode[] = data.nodes.map((n) => ({
      ...n,
      id: mapNode(n.id),
      treeId,
      branchId: mapBranch(n.branchId),
      parentId: n.parentId === null ? null : mapNode(n.parentId),
      status: n.status === 'streaming' ? 'error' : n.status,
      error: n.status === 'streaming' ? 'Interrupted before the reply finished' : n.error,
    }));
    await this.repo.importTree(tree, branches, nodes);
    return { tree, branches, nodes };
  }

  // -------------------------------------------------------------- helpers

  private requireProvider(providerId: string): LlmProvider {
    const provider = this.deps.providers.get(providerId);
    if (!provider) throw new ValidationError(`Unknown provider "${providerId}"`);
    return provider;
  }
}

/** Streams a prompt to completion; returns null on provider error. */
async function collectText(
  provider: LlmProvider,
  model: string,
  prompt: { system: string | null; messages: ChatMessage[] },
  signal: AbortSignal,
): Promise<string | null> {
  let text = '';
  for await (const event of provider.stream({
    model,
    system: prompt.system,
    messages: prompt.messages,
    maxOutputTokens: 1024,
    signal,
  })) {
    if (event.type === 'delta') text += event.text;
    else if (event.type === 'error') return null;
  }
  return text;
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === '' ? null : value;
}

function stripUndefined(usage: Partial<TokenUsage>): Partial<TokenUsage> {
  const out: Partial<TokenUsage> = {};
  if (usage.inputTokens !== undefined) out.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) out.outputTokens = usage.outputTokens;
  return out;
}

function defaultBranchTitle(anchorQuote: string | null, node: ChatNode): string {
  const source = (anchorQuote ?? node.content).replace(/\s+/g, ' ').trim();
  if (!source) return 'New branch';
  const words = source.split(' ').slice(0, 6).join(' ');
  const clipped = words.length > 48 ? `${words.slice(0, 47)}…` : words;
  return anchorQuote ? `“${clipped}”` : `Branch: ${clipped}`;
}
