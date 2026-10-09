import type { Branch, ChatNode, NodeErrorKind, StreamEvent } from '@tangent/shared';
import { ConflictError, ValidationError } from '../errors.js';
import { errorText, type ServiceContext } from '../services/context.js';
import {
  pickGenerationLimits,
  type ContextResolver,
  type GenerationLimits,
} from './context-resolver.js';
import { chatNode, emptyReplyState, finalTokenUsage, type Replier } from './reply.js';
import type { Titler } from './titler.js';

export interface BeginSendResult {
  branch: Branch;
  userNode: ChatNode;
  assistantNode: ChatNode;
}

/** Options of `runGeneration`. */
export interface RunGenerationOptions extends GenerationLimits {
  /**
   * A reservation the caller already made for the reply (the open pool's
   * ceiling hold, or Tangent credit's least hold), passed to the provider as
   * `usageTag.reservationId`.
   */
  reservationId?: string;
  /** `required`: "Check sources", the reply must search (when the provider can). */
  ground?: 'required';
}

/** A message sent to a branch, and the reply generated for it. */
export class SendService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly resolver: ContextResolver,
    private readonly replier: Replier,
    private readonly titler: Titler,
  ) {}

  /**
   * Appends a user node to the branch leaf (or the branch point for an empty
   * branch) and a `streaming` assistant node after it, atomically.
   * Rejects with ConflictError if the branch leaf is still streaming.
   */
  async beginSend(branchId: string, content: string): Promise<BeginSendResult> {
    const { branch } = await this.ctx.owned.branch(branchId);
    if (!content.trim()) throw new ValidationError('Message is empty');
    const route = this.ctx.routes.runnable(branch);
    this.ctx.routes.requireProvider(route);
    const own = await this.ctx.repos.trees.listBranchNodes(branchId);
    const leaf = own.at(-1);
    if (leaf?.status === 'streaming') {
      throw new ConflictError('A reply is still being generated in this branch');
    }
    const now = this.ctx.now();
    const seq = leaf ? leaf.seq + 1 : 0;
    const userNode = chatNode({
      id: this.ctx.newId(),
      treeId: branch.treeId,
      branchId,
      parentId: leaf?.id ?? branch.branchPointNodeId,
      seq,
      role: 'user',
      content,
      createdAt: now,
    });
    const assistantNode = chatNode({
      id: this.ctx.newId(),
      treeId: branch.treeId,
      branchId,
      parentId: userNode.id,
      seq: seq + 1,
      role: 'assistant',
      status: 'streaming',
      providerId: route.providerId,
      model: this.ctx.routes.modelOf(route),
      createdAt: now,
    });
    await this.ctx.repos.trees.appendNodes([userNode, assistantNode], now);
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
    const state = emptyReplyState();
    const finish = async (
      outcome: { status: 'complete' } | { status: 'error'; message: string; kind: NodeErrorKind },
    ): Promise<ChatNode> => {
      const { content, sources } = state;
      const usage = finalTokenUsage(state.usage);
      const { status } = outcome;
      const failed = outcome.status === 'error' ? outcome : null;
      const error = failed?.message ?? null;
      const errorKind = failed?.kind ?? null;
      const patch = { content, status, error, errorKind, usage, sources };
      await this.ctx.repos.trees.updateNode(assistantNode.id, patch);
      return { ...assistantNode, ...patch };
    };

    try {
      const inputs = await this.resolver.loadPlanInputs(branch.id, userNode.id);
      const limits = pickGenerationLimits(options);
      const reply = yield* this.replier.prepareReply(inputs, signal, limits, options.ground);
      const terminal = yield* this.replier.streamReply(
        inputs.provider,
        reply,
        {
          usageTag: {
            purpose: 'reply',
            treeId: inputs.tree.id,
            branchId: branch.id,
            nodeId: assistantNode.id,
            ...(options.reservationId ? { reservationId: options.reservationId } : {}),
          },
          nodeId: assistantNode.id,
          ...(limits.maxOutputTokens !== undefined
            ? { maxOutputTokens: limits.maxOutputTokens }
            : {}),
        },
        state,
        signal,
      );

      if (terminal.status === 'error') {
        const node = await finish(terminal);
        yield { type: 'error', nodeId: node.id, message: terminal.message, node };
        return;
      }
      const node = await finish(terminal);
      branch =
        (await this.titler.titleFirstExchange(inputs.tree, inputs.branch, userNode, node)) ??
        branch;
      yield { type: 'done', node, branch };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Generation failed';
      let node: ChatNode | null;
      try {
        node = await finish({ status: 'error', message, kind: 'failed' });
      } catch (saveErr) {
        node = null;
        this.ctx.log('reply_save_failed', {
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
}
