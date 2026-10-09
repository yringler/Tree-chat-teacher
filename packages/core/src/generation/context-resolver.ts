import type {
  Branch,
  ChatMessage,
  ChatNode,
  ContextPlan,
  ContextPlanResponse,
  InputOverflow,
  LlmProvider,
  ProviderCapabilities,
  ProviderError,
  ProviderRoute,
  ReasoningEffort,
  SummaryRequest,
  Tree,
  UsageTag,
} from '@tangent/shared';
import { auxOutputTokens, clipUtf16, replyOutputTokens } from '@tangent/shared';
import { assembleContext, summaryKeyString } from '../context/assemble.js';
import { overflowBudget } from '../context/overflow.js';
import { buildSummaryPrompt, renderPlan } from '../context/render.js';
import { ValidationError } from '../errors.js';
import { errorText, type ServiceContext } from '../services/context.js';
import type { GenerationProfile, PoolProfile } from '../services/profile.js';

/**
 * The most summaries one send generates. Each is a paid call the reply waits
 * on, made one after another; 16 covers a chain nested deeper than anyone
 * branches by hand (fifteen summary-mode levels and a compaction), and
 * bounds an imported chain of hundreds to under a minute of waiting.
 */
const MAX_SUMMARY_CALLS = 16;

/**
 * A generation's own limits (power's settings), as a send, a context preview,
 * a compare candidate or a review passes them.
 */
export interface GenerationLimits {
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
  funding: Branch['funding'];
  /** `ProviderCapabilities.maxContextTokens`. */
  contextTokens: number;
  /** `ProviderCapabilities.maxOutputTokens`. */
  maxOutputTokens: number;
  reasoning: boolean;
  /** The settings' input cap (`ChatSettings.maxInputTokens`). */
  maxInputTokens: number | null;
}

/** Everything a reply in an owned branch is planned from (`loadPlanInputs`). */
export interface PlanInputs {
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

/** A status line while a reply is prepared (a summary being written, …). */
export interface StatusEvent {
  type: 'status';
  message: string;
}

/**
 * Runs `steps` (a `resolvePlan`) to its end, yielding each status message as
 * a `status` event; returns its result.
 */
export async function* drainStatus<T>(
  steps: AsyncGenerator<string, T>,
): AsyncGenerator<StatusEvent, T> {
  let step = await steps.next();
  while (!step.done) {
    yield { type: 'status', message: step.value };
    step = await steps.next();
  }
  return step.value;
}

/** Runs `steps` to its end, ignoring what it yields; returns its result. */
async function finalValue<T>(steps: AsyncGenerator<unknown, T>): Promise<T> {
  let step = await steps.next();
  while (!step.done) step = await steps.next();
  return step.value;
}

/**
 * `provider`'s capabilities for `model`, with its real limits where the
 * provider can look them up (`LlmProvider.resolveCapabilities`).
 */
export function capabilitiesOf(
  provider: LlmProvider,
  model: string,
): Promise<ProviderCapabilities> {
  return provider.resolveCapabilities
    ? provider.resolveCapabilities(model)
    : Promise.resolve(provider.capabilities(model));
}

/**
 * `branch` with its anchor quote cut to `maxChars` UTF-16 units (marked with
 * an ellipsis): the unit the pool's message limit is checked in.
 */
function clipAnchorQuote(branch: Branch, maxChars: number | undefined): Branch {
  const quote = branch.anchorQuote;
  if (maxChars === undefined || quote === null || quote.length <= maxChars) return branch;
  return { ...branch, anchorQuote: clipUtf16(quote, maxChars) };
}

/**
 * Loads what a reply is planned from, works out its budgets, and resolves the
 * summaries its context needs (generating and caching the missing ones).
 */
export class ContextResolver {
  /** The open pool's bounds on what a generation sends; null elsewhere. */
  private readonly pool: PoolProfile | null;

  constructor(
    private readonly ctx: ServiceContext,
    profile: GenerationProfile,
  ) {
    this.pool = profile.kind === 'pool' ? profile : null;
  }

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
    const plan = await finalValue(
      this.resolvePlan(inputs, options.resolveSummaries, options.signal, options.limits),
    );
    const model = this.ctx.routes.modelOf(inputs.branch);
    const caps = inputs.provider.capabilities(model);
    const rendered = renderPlan(plan, { supportsSystemPrompt: caps.supportsSystemPrompt });
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
          this.ctx.log('count_tokens_failed', {
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
      funding: this.ctx.routes.fundingOf(inputs.branch),
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
  async loadPlanInputs(
    branchId: string,
    nodeId: string | null,
    extra: { tail?: ChatNode; route?: ProviderRoute & { model: string } } = {},
  ): Promise<PlanInputs> {
    const repo = this.ctx.repos.trees;
    const owned = await this.ctx.owned.branch(branchId);
    // The only way into the context's system prompt (the `tree-system-prompt` segment).
    const override = this.pool?.systemPrompt;
    const tree = override === undefined ? owned.tree : { ...owned.tree, systemPrompt: override };
    const clip = (b: Branch): Branch => clipAnchorQuote(b, this.pool?.anchorQuoteMaxChars);
    const route = extra.route;
    const routed = (b: Branch): Branch =>
      route && b.id === branchId
        ? { ...b, providerId: route.providerId, funding: route.funding, model: route.model }
        : b;
    const stored = clip(owned.branch);
    const branch = routed(stored);
    const chain = (await repo.getBranchChain(branchId)).map((b) => routed(clip(b)));

    const tail = extra.tail;
    let path: ChatNode[];
    if (tail) {
      path = [...(tail.parentId ? await repo.getAncestorPath(tail.parentId) : []), tail];
    } else if (nodeId) {
      const node = await repo.getNode(nodeId);
      if (!node || node.branchId !== branchId)
        throw new ValidationError('Node is not in this branch');
      path = await repo.getAncestorPath(nodeId);
    } else {
      const own = await repo.listBranchNodes(branchId);
      const leaf = own.at(-1);
      const tail = leaf?.id ?? branch.branchPointNodeId;
      path = tail ? await repo.getAncestorPath(tail) : [];
    }
    // With a locked prompt, a stored `system` node (e.g. from an imported
    // backup) must not reach the system channel: it is planned as a user turn.
    if (override !== undefined) {
      path = path.map((n) => (n.role === 'system' ? { ...n, role: 'user' } : n));
    }
    const provider = this.ctx.routes.requireProvider(branch);
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

  /**
   * A reply's output cap on `model` (`requested`, else the settings' default
   * for a reasoning or a plain model, within the model's limit) and the input
   * budget that leaves in its context window, within the settings' cap and
   * `requestedInput` (power's input limit).
   */
  async budgetFor(
    provider: LlmProvider,
    model: string,
    requested?: number,
    requestedInput?: number,
  ): Promise<{ maxInputTokens: number; maxOutput: number }> {
    const caps = await capabilitiesOf(provider, model);
    const { reservedOutputTokens, reasoningOutputTokens } = this.ctx.settings;
    const maxOutput = replyOutputTokens({
      reasoning: caps.reasoning === true,
      maxOutputTokens: caps.maxOutputTokens,
      requested: requested ?? null,
      defaults: { plain: reservedOutputTokens, reasoning: reasoningOutputTokens },
    });
    let maxInputTokens = Math.max(1, caps.maxContextTokens - maxOutput);
    if (this.ctx.settings.maxInputTokens !== null) {
      maxInputTokens = Math.min(maxInputTokens, this.ctx.settings.maxInputTokens);
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
      this.ctx.routes.requireProvider(route),
      this.ctx.routes.modelOf({ model }),
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
    const { branch } = await this.ctx.owned.branch(branchId);
    const model = this.ctx.routes.modelOf(branch);
    const caps = await capabilitiesOf(this.ctx.routes.requireProvider(branch), model);
    return {
      providerId: branch.providerId,
      model,
      funding: this.ctx.routes.fundingOf(branch),
      contextTokens: caps.maxContextTokens,
      maxOutputTokens: caps.maxOutputTokens,
      reasoning: caps.reasoning === true,
      maxInputTokens: this.ctx.settings.maxInputTokens,
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
  async *resolvePlan(
    inputs: PlanInputs,
    generate: boolean,
    signal?: AbortSignal,
    limits: GenerationLimits = {},
  ): AsyncGenerator<string, ContextPlan> {
    const summaries = new Map<string, string>();
    const failed = new Set<string>();
    const { provider: summaryProvider, model: summaryModel } = this.ctx.routes.summaryTarget(
      inputs.summaryBranch,
    );
    const { maxInputTokens } = await this.budgetFor(
      inputs.provider,
      this.ctx.routes.modelOf(inputs.branch),
      limits.maxOutputTokens,
      limits.maxInputTokens,
    );
    const lookedUp = new Set<string>();
    const estimateTokens = this.pool?.estimateTokens;

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
        ...(estimateTokens ? { estimateTokens } : {}),
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
        const hit = await this.ctx.repos.summaries.getSummary(
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
        await this.ctx.repos.summaries.putSummary({
          anchorNodeId: request.key.anchorNodeId,
          sourceHash: request.key.sourceHash,
          providerId: summaryProvider.id,
          model: summaryModel,
          content: text,
          treeId: inputs.tree.id,
          createdAt: this.ctx.now(),
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
    const pool = this.pool;
    const prompt = buildSummaryPrompt(
      request,
      pool
        ? {
            maxInputTokens: (await this.budgetFor(provider, model)).maxInputTokens,
            estimateTokens: pool.estimateTokens,
          }
        : undefined,
    );
    if (prompt === null) return null;
    const text = await collectText(
      provider,
      model,
      prompt,
      signal ?? new AbortController().signal,
      { purpose: 'summary', ...target, nodeId: null },
      this.ctx.settings.summaryEffort,
      (error) => {
        // A summary cut short by a cancelled send didn't fail.
        if (signal?.aborted) return;
        this.ctx.log('summary_failed', {
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
}

/** Streams a prompt to completion; returns null on provider error, after passing it to `onError`. */
export async function collectText(
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
