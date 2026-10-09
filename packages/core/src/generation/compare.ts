import type {
  Branch,
  BranchFunding,
  CandidateEvent,
  CandidateRequest,
  Citation,
  CommitCandidateResponse,
  TokenUsage,
} from '@tangent/shared';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { errorText, type ServiceContext } from '../services/context.js';
import {
  pickGenerationLimits,
  type ContextResolver,
  type GenerationLimits,
} from './context-resolver.js';
import { chatNode, emptyReplyState, finalTokenUsage, type Replier } from './reply.js';
import type { Titler } from './titler.js';

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

/** Compare: a question answered off the tree on another route, then kept or dropped. */
export class CompareService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly resolver: ContextResolver,
    private readonly replier: Replier,
    private readonly titler: Titler,
  ) {}

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
    const { branch } = await this.ctx.owned.branch(branchId);
    if (!request.content.trim()) throw new ValidationError('Message is empty');
    const leaf = (await this.ctx.repos.trees.listBranchNodes(branchId)).at(-1);
    if (leaf?.status === 'streaming') {
      throw new ConflictError('A reply is still being generated in this branch');
    }
    const route = this.ctx.routes.requestedRoute(request, branch);
    this.ctx.routes.requireProvider(route);
    return {
      id: this.ctx.newId(),
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
      const parent = prepared.parentId
        ? await this.ctx.repos.trees.getNode(prepared.parentId)
        : null;
      const question = chatNode({
        id: `${prepared.id}:q`,
        treeId: prepared.branch.treeId,
        branchId,
        parentId: prepared.parentId,
        seq: parent?.branchId === branchId ? parent.seq + 1 : 0,
        role: 'user',
        content: prepared.content,
        createdAt: this.ctx.now(),
      });
      const inputs = await this.resolver.loadPlanInputs(branchId, null, {
        tail: question,
        route: {
          providerId: prepared.providerId,
          funding: prepared.funding,
          model: prepared.model,
        },
      });
      const reply = yield* this.replier.prepareReply(inputs, signal, prepared.limits);
      const state = emptyReplyState();
      const stream = this.replier.streamReply(
        inputs.provider,
        reply,
        {
          usageTag: { purpose: 'reply', treeId: inputs.tree.id, branchId, nodeId: null },
          nodeId: question.id,
          ...(prepared.limits.maxOutputTokens !== undefined
            ? { maxOutputTokens: prepared.limits.maxOutputTokens }
            : {}),
        },
        state,
        signal,
      );
      let next = await stream.next();
      while (!next.done) {
        const event = next.value;
        // Usage is accumulated into `state` and reported once, with `done`.
        if (event.type === 'delta') yield { type: 'delta', text: event.text };
        else if (event.type === 'status') yield event;
        next = await stream.next();
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
          model: reply.model,
          usage: finalTokenUsage(state.usage),
          sources: state.sources,
          createdAt: this.ctx.now(),
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
    const { branch } = await this.ctx.owned.branch(held.branchId);
    if (branch.treeId !== held.treeId) throw new NotFoundError('Branch');
    const repo = this.ctx.repos.trees;
    const leaf = (await repo.listBranchNodes(branch.id)).at(-1);
    if (leaf?.status === 'streaming') {
      throw new ConflictError('A reply is still being generated in this branch');
    }
    if ((leaf?.id ?? branch.branchPointNodeId) !== held.parentId) {
      throw new ConflictError('The conversation moved on since you compared; ask again');
    }
    const now = this.ctx.now();
    const seq = leaf ? leaf.seq + 1 : 0;
    const userNode = chatNode({
      id: this.ctx.newId(),
      treeId: branch.treeId,
      branchId: branch.id,
      parentId: held.parentId,
      seq,
      role: 'user',
      content: held.question,
      createdAt: now,
    });
    const assistantNode = chatNode({
      id: this.ctx.newId(),
      treeId: branch.treeId,
      branchId: branch.id,
      parentId: userNode.id,
      seq: seq + 1,
      role: 'assistant',
      content: held.content,
      providerId: held.providerId,
      model: held.model,
      usage: held.usage,
      sources: held.sources,
      createdAt: now,
    });
    await repo.appendNodes([userNode, assistantNode], now);
    return { userNode, assistantNode, branch };
  }

  /**
   * Auto-titles the branch (and the tree, for the trunk) after a committed
   * first exchange, like a send; best-effort, never throws (the exchange is
   * already in the tree). Returns the branch as it now is.
   */
  async titleCommitted(committed: CommitCandidateResponse): Promise<Branch> {
    const { userNode, assistantNode, branch } = committed;
    if (!this.ctx.settings.autoTitle || assistantNode.seq !== 1) return branch;
    try {
      const owned = await this.ctx.owned.branch(branch.id);
      return (
        (await this.titler.titleFirstExchange(owned.tree, owned.branch, userNode, assistantNode)) ??
        branch
      );
    } catch (err) {
      this.ctx.log('auto_title_failed', {
        treeId: branch.treeId,
        branchId: branch.id,
        error: errorText(err),
      });
      return branch;
    }
  }
}
