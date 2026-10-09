import {
  foldSystemPrompt,
  REPLY_STREAM_ENDED_ERROR,
  type BranchFunding,
  type ChatNode,
  type ReviewEvent,
  type ReviewRequest,
  type TokenUsage,
} from '@tangent/shared';
import { buildReviewPrompt, renderPlan } from '../context/render.js';
import { ValidationError } from '../errors.js';
import type { ServiceContext } from '../services/context.js';
import {
  drainStatus,
  pickGenerationLimits,
  type ContextResolver,
  type GenerationLimits,
} from './context-resolver.js';
import { finalTokenUsage, providerErrorMessage, stripUndefined } from './reply.js';

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

/** A second model's review of a reply. Nothing is persisted. */
export class ReviewService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly resolver: ContextResolver,
  ) {}

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
    const node = await this.ctx.owned.node(nodeId);
    if (node.role !== 'assistant')
      throw new ValidationError('Only assistant replies can be reviewed');
    if (node.status !== 'complete') throw new ValidationError('That reply has not finished');
    const route = this.ctx.routes.requestedRoute(request, null);
    this.ctx.routes.requireProvider(route);
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
      const inputs = await this.resolver.loadPlanInputs(review.node.branchId, review.node.id);
      // The output cap is the review's, not a reply's on the branch's model.
      const { maxOutputTokens: reviewOutput, ...contextLimits } = review.limits;
      const plan = yield* drainStatus(
        this.resolver.resolvePlan(inputs, true, signal, contextLimits),
      );
      const caps = inputs.provider.capabilities(this.ctx.routes.modelOf(inputs.branch));
      const context = renderPlan(plan, { supportsSystemPrompt: caps.supportsSystemPrompt });
      const reviewer = this.ctx.routes.requireProvider(review);
      const prompt = buildReviewPrompt(context, review.node.model);
      const rendered = reviewer.capabilities(review.model).supportsSystemPrompt
        ? prompt
        : foldSystemPrompt(prompt);
      const { maxOutput } = await this.resolver.budgetFor(reviewer, review.model, reviewOutput);
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
          yield { type: 'error', message: providerErrorMessage(event.error) };
          return;
        }
      }
      yield { type: 'error', message: REPLY_STREAM_ENDED_ERROR };
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : 'Review failed' };
    }
  }
}
