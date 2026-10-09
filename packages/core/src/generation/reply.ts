import {
  CHECK_SOURCES_INSTRUCTIONS,
  DEFAULT_GROUNDING_MODE,
  GROUNDING_INSTRUCTIONS,
  REPLY_CANCELLED_ERROR,
  REPLY_CUT_OFF_ERROR,
  REPLY_EMPTY_ERROR,
  REPLY_STREAM_ENDED_ERROR,
  REPLY_THINKING_ONLY_ERROR,
  isLengthStop,
  type Branch,
  type ChatNode,
  type Citation,
  type ContextPlan,
  type LlmProvider,
  type NodeErrorKind,
  type ProviderCapabilities,
  type ProviderError,
  type ProviderRoute,
  type StreamEvent,
  type TokenUsage,
  type UsageTag,
  type WebSearchRequest,
} from '@tangent/shared';
import { renderPlan, replyInstructions } from '../context/render.js';
import { decideGrounding, type GroundingDecision } from '../grounding/policy.js';
import { errorText, type ServiceContext } from '../services/context.js';
import {
  drainStatus,
  type ContextResolver,
  type GenerationLimits,
  type PlanInputs,
  type StatusEvent,
} from './context-resolver.js';

/** What `streamReply` has received so far (updated as it streams). */
export interface ReplyState {
  content: string;
  usage: Partial<TokenUsage>;
  /** Sources of a web search the reply ran; null when it didn't search. */
  sources: Citation[] | null;
}

export function emptyReplyState(): ReplyState {
  return { content: '', usage: {}, sources: null };
}

type ReplyEvent = Extract<StreamEvent, { type: 'status' | 'delta' | 'usage' }>;
export type ReplyTerminal =
  { status: 'complete' } | { status: 'error'; message: string; kind: NodeErrorKind };

/** A reply's planned context, and what it runs with (`prepareReply`). */
export interface PreparedReply {
  plan: ContextPlan;
  model: string;
  caps: ProviderCapabilities;
  grounding: GroundingDecision;
}

/**
 * False once automatic web searches on `route` should stop
 * (`ChatServiceDeps.groundingAllowance`).
 */
export type GroundingAllowance = (route: ProviderRoute) => Promise<boolean>;

const SUMMARY_MISSING_STATUS = 'A summary could not be generated; sending without it.';

/** Plans and streams replies: a send's and a compare candidate's. */
export class Replier {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly resolver: ContextResolver,
    private readonly groundingAllowance: GroundingAllowance | undefined,
  ) {}

  /**
   * Resolves the context of a reply planned from `inputs` (summaries
   * generated and cached, yielding `status`), says so when it goes without
   * one, and decides its grounding: whether it is offered (or, for `ground`,
   * must run) a web search.
   */
  async *prepareReply(
    inputs: PlanInputs,
    signal: AbortSignal,
    limits: GenerationLimits,
    ground?: 'required',
  ): AsyncGenerator<StatusEvent, PreparedReply> {
    const plan = yield* drainStatus(this.resolver.resolvePlan(inputs, true, signal, limits));
    if (missesSummary(plan)) yield { type: 'status', message: SUMMARY_MISSING_STATUS };
    const model = this.ctx.routes.modelOf(inputs.branch);
    const caps = inputs.provider.capabilities(model);
    const grounding = await this.decideGrounding(inputs, plan, caps.supportsWebSearch, ground);
    return { plan, model, caps, grounding };
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
  async *streamReply(
    provider: LlmProvider,
    reply: PreparedReply,
    target: {
      usageTag: UsageTag;
      /** The node the `delta`/`usage` events are for. */
      nodeId: string;
      /** The output cap the caller asks for (GenerationLimits.maxOutputTokens). */
      maxOutputTokens?: number;
    },
    state: ReplyState,
    signal: AbortSignal,
  ): AsyncGenerator<ReplyEvent, ReplyTerminal> {
    const { plan, model, caps } = reply;
    const { nodeId } = target;
    const { maxOutput } = await this.resolver.budgetFor(provider, model, target.maxOutputTokens);
    let terminal: ReplyTerminal | null = null;
    let webSearch = this.webSearchRequest(reply.grounding, caps);
    for (let attempt = 0; attempt < 2; attempt++) {
      let retryWithoutSearch = false;
      // After the history, not in the system prompt: see `replyInstructions`. A required
      // search is asked for here even where the provider can't enforce it.
      const turnInstructions =
        webSearch === undefined
          ? undefined
          : replyInstructions(
              reply.grounding.mode === 'required'
                ? CHECK_SOURCES_INSTRUCTIONS
                : GROUNDING_INSTRUCTIONS,
            );
      const rendered = renderPlan(plan, { supportsSystemPrompt: caps.supportsSystemPrompt });
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
            message: providerErrorMessage(event.error),
            kind: event.error.code === 'aborted' ? 'cancelled' : 'provider',
          };
        }
      }
      if (searched) state.sources = cited;
      if (!retryWithoutSearch) break;
    }
    return (
      terminal ?? {
        status: 'error',
        message: REPLY_STREAM_ENDED_ERROR,
        kind: 'provider',
      }
    );
  }

  /** Whether replies on `branch` can run a web search ("Check sources"). */
  canSearch(branch: Branch): boolean {
    try {
      return this.ctx.routes.requireProvider(branch).capabilities(this.ctx.routes.modelOf(branch))
        .supportsWebSearch;
    } catch (err) {
      this.ctx.log('can_search_failed', {
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
    ground: 'required' | undefined,
  ): Promise<GroundingDecision> {
    const settings = this.ctx.settings.grounding;
    const lastUser = inputs.path.at(-1);
    const input = {
      policy: settings.policy,
      branchMode: settings.ignoreBranchSetting
        ? DEFAULT_GROUNDING_MODE
        : (inputs.branch.grounding ?? DEFAULT_GROUNDING_MODE),
      explicit: ground === 'required',
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
    if (decision.mode !== 'auto' || !this.groundingAllowance) return decision;
    const route = { providerId: inputs.branch.providerId, funding: inputs.branch.funding };
    let allowed: boolean;
    try {
      allowed = await this.groundingAllowance(route);
    } catch (err) {
      allowed = false;
      this.ctx.log('grounding_allowance_failed', { ...route, error: errorText(err) });
    }
    return allowed ? decision : decideGrounding({ ...input, autoAllowed: false });
  }

  /**
   * The search a reply is offered: `required` only where the provider can
   * enforce it (`requiredWebSearch`), else offered and asked for in the
   * reply's instructions.
   */
  private webSearchRequest(
    decision: GroundingDecision,
    caps: ProviderCapabilities,
  ): WebSearchRequest | undefined {
    if (decision.mode === 'none') return undefined;
    const required = decision.mode === 'required' && caps.requiredWebSearch === true;
    return { mode: required ? 'required' : 'auto', maxUses: this.ctx.settings.grounding.maxUses };
  }
}

/** A stored node; what isn't given is empty: no content or error, no route, no usage. */
export function chatNode(
  fields: Pick<ChatNode, 'id' | 'treeId' | 'branchId' | 'parentId' | 'seq' | 'role' | 'createdAt'> &
    Partial<Pick<ChatNode, 'content' | 'status' | 'providerId' | 'model' | 'usage' | 'sources'>>,
): ChatNode {
  return {
    content: '',
    status: 'complete',
    error: null,
    errorKind: null,
    providerId: null,
    model: null,
    usage: null,
    ...fields,
  };
}

/** A failed provider call as the reply's error: a cancelled one says so in the apps' words. */
export function providerErrorMessage(error: ProviderError): string {
  return error.code === 'aborted' ? REPLY_CANCELLED_ERROR : error.message;
}

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

/**
 * The outcome of a reply the provider finished with `stopReason`: complete,
 * unless it stopped at its output cap (`isLengthStop`; with no text at all, a
 * reasoning model thought until the cap) or wrote nothing. Those are errors
 * with fixed messages (stop-reason.ts) and kinds the apps recognize.
 */
function replyOutcome(content: string, stopReason: string | null): ReplyTerminal {
  const empty = content.trim() === '';
  if (isLengthStop(stopReason)) {
    return empty
      ? { status: 'error', message: REPLY_THINKING_ONLY_ERROR, kind: 'thinking_only' }
      : { status: 'error', message: REPLY_CUT_OFF_ERROR, kind: 'cut_off' };
  }
  if (empty) return { status: 'error', message: REPLY_EMPTY_ERROR, kind: 'empty' };
  return { status: 'complete' };
}

/** Accumulated usage as stored: null when the provider reported none. */
export function finalTokenUsage(usage: Partial<TokenUsage>): TokenUsage | null {
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined
    ? { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 }
    : null;
}

export function stripUndefined(usage: Partial<TokenUsage>): Partial<TokenUsage> {
  const out: Partial<TokenUsage> = {};
  if (usage.inputTokens !== undefined) out.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) out.outputTokens = usage.outputTokens;
  return out;
}
