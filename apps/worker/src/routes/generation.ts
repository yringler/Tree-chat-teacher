import {
  DomainError,
  ValidationError,
  type ChatService,
  type GenerationLimits,
  type HeldCandidate,
  type PreparedReview,
} from '@tangent/core';
import { API_ROUTES, type Branch, type CandidateEvent } from '@tangent/shared';
import { Hono } from 'hono';
import { assertCanGenerate } from '../billing/gate.js';
import { assertCreditCovers, replyHoldMicros } from '../billing/service.js';
import { treeSession } from '../do/tree-session-client.js';
import type {
  CreditReplyHold,
  SessionCommitBody,
  SessionHoldResponse,
  SessionSendBody,
} from '../do/tree-session.js';
import { callPayer, isPoolFunded, type AppBindings, type AppContext } from '../env.js';
import { validateJson } from '../http/errors.js';
import { sseFromAsyncIterable } from '../http/sse.js';
import { generationLimits } from '../input-limit.js';
import { chatOf, keysOf, type OpenKeys } from './request-chat.js';
import { logEvent } from '../log.js';

/**
 * What a send on Tangent credit reserves before its nodes are written (the
 * tree's Durable Object, `reserveCreditReply`): the reply's worst case on the
 * branch's route and model under the send's limits, resolved here like the
 * pool's parameters, so the Durable Object reads no prices of its own.
 */
async function creditReplyHold(
  c: AppContext,
  keys: OpenKeys | null,
  branch: Branch,
  limits: GenerationLimits,
): Promise<CreditReplyHold> {
  // Built for the account the gate settled on, as the send will run.
  const budget = await chatOf(c, keys, true).routeBudget(branch, branch.model, limits);
  return {
    providerId: branch.providerId,
    model: branch.model,
    holdMicros: await replyHoldMicros(c.env, branch.model, budget),
  };
}

/**
 * A review or compare answer on Tangent credit streams from the Worker, so
 * nothing is reserved before its 200: this checks up front that the
 * available credit covers its worst case before its prompt exists (402
 * naming what it needs), the way a send's reservation does. The meter's
 * reservation still stops a race.
 */
async function assertCreditCoversReply(
  c: AppContext,
  chat: ChatService,
  prepared: Pick<PreparedReview, 'providerId' | 'funding' | 'model' | 'limits'>,
): Promise<void> {
  const account = c.var.account;
  if (callPayer(account, prepared.funding) === 'own-key') return;
  const budget = await chat.routeBudget(prepared, prepared.model, prepared.limits);
  await assertCreditCovers(c.env, account, await replyHoldMicros(c.env, prepared.model, budget));
}

/**
 * Everything that calls a model for a message: sends (and their streams,
 * through the tree's Durable Object), reviews and compare candidates. Each
 * passes `assertCanGenerate` (billing/gate.ts) before anything is written or
 * sent upstream.
 */
const { sendMessage, reviewNode, streamCandidate } = API_ROUTES;

export function generationRoutes(): Hono<AppBindings> {
  const api = new Hono<AppBindings>();

  // ---- messages (delegated to the tree's Durable Object)
  api.post('/branches/:branchId/messages', validateJson(sendMessage), async (c) => {
    const keys = await keysOf(c);
    const req = c.req.valid('json');
    const chat = chatOf(c, keys);
    // The route and model the send runs on: Learn's own where the branch names one it can't run.
    const branch = chat.runnableBranch(await chat.getOwnedBranch(c.req.param('branchId')));
    // The route is the Durable Object's only way in, so this gate covers it. On the
    // pool, the Durable Object reserves the reply before writing any node.
    const account = await assertCanGenerate(c, {
      purpose: 'send',
      providerId: branch.providerId,
      funding: branch.funding,
      model: branch.model,
      keys,
      content: req.content,
    });
    // "Check sources" needs a provider that can search; the pool's holds don't cover a search.
    if (req.ground === 'required' && (isPoolFunded(account) || !chat.canSearch(branch))) {
      throw new ValidationError("This conversation's model can't check sources");
    }
    // The Durable Object gets the still-sealed cookie value in the body (never
    // a header, which request logs may capture) and opens it itself. The output
    // cap and the input limit are power's settings, clamped on Tangent credit:
    // Learn's replies keep its own (input-limit.ts).
    const { maxOutputTokens, maxInputTokens, inputOverflow, ...rest } = req;
    const limits = generationLimits(c.env, account, branch.funding, {
      maxOutputTokens,
      maxInputTokens,
      inputOverflow,
    });
    const body: SessionSendBody = {
      ...rest,
      ...limits,
      account,
      ...(keys ? { sealedKeys: keys.sealed } : {}),
      ...(callPayer(account, branch.funding) === 'credit'
        ? { creditReply: await creditReplyHold(c, keys, branch, limits) }
        : {}),
    };
    return treeSession(c.env, branch.treeId).send(branch.id, body);
  });
  // The node is resolved here: the Durable Object takes the caller's word for it.
  api.get('/nodes/:nodeId/stream', async (c) => {
    const node = await chatOf(c).getOwnedNode(c.req.param('nodeId'));
    return treeSession(c.env, node.treeId).stream(node.id, c.var.account);
  });
  api.post('/nodes/:nodeId/cancel', async (c) => {
    const node = await chatOf(c).getOwnedNode(c.req.param('nodeId'));
    return treeSession(c.env, node.treeId).cancel(node.id, c.var.account);
  });

  // ---- reviews: streamed straight from the Worker. Nothing is persisted, so
  // there is no Durable Object run to reconnect to; a dropped client aborts
  // the upstream request (stops billing) through the request signal.
  api.post('/nodes/:nodeId/review', validateJson(reviewNode), async (c) => {
    const req = c.req.valid('json');
    const keys = await keysOf(c);
    let chat = chatOf(c, keys);
    const node = await chat.getOwnedNode(c.req.param('nodeId'));
    const branch = chat.runnableBranch(await chat.getOwnedBranch(node.branchId));
    // The client picks the reviewer model here, so the allowlist is what bounds it.
    // The review is metered iff the reviewer is on Tangent credit (its funding). The
    // context is resolved like a send on the node's branch, so missing summaries are
    // generated on that branch's route: its credit is checked too. Never on the pool (403).
    await assertCanGenerate(c, {
      purpose: 'review',
      providerId: req.providerId,
      funding: req.funding ?? 'own-key',
      model: req.model,
      alsoSpendsOn: { providerId: branch.providerId, funding: branch.funding },
      keys,
    });
    chat = chatOf(c, keys, true);
    // Power's reply length and input limit, clamped like a send's on the reviewer's
    // route (it is the one that reads the conversation): Tangent credit's input cap
    // applies with or without a setting; Learn takes none (input-limit.ts).
    const prepared = await chat.prepareReview(
      node.id,
      req,
      generationLimits(c.env, c.var.account, req.funding ?? 'own-key', req),
    );
    await assertCreditCoversReply(c, chat, prepared);
    return sseFromAsyncIterable(c, chat.runReview(prepared, c.req.raw.signal), (event) => event);
  });

  // ---- compare (shared/compare.ts): each candidate streams straight from the
  // Worker, like a review, and nothing enters the tree until the user picks one.
  // A finished candidate is held by the tree's Durable Object (for
  // CANDIDATE_TTL_MS), which also appends the picked one, under its send lock.
  api.post('/branches/:branchId/candidates', validateJson(streamCandidate), async (c) => {
    const req = c.req.valid('json');
    const keys = await keysOf(c);
    let chat = chatOf(c, keys);
    const branch = chat.runnableBranch(await chat.getOwnedBranch(c.req.param('branchId')));
    // The route as ChatService resolves it (`requestedRoute`): absent = the branch's,
    // and Learn's fixed funding (the branch's) always wins.
    const learn = c.var.account.mode === 'simple';
    const route = req.providerId
      ? { providerId: req.providerId, funding: req.funding ?? ('own-key' as const) }
      : { providerId: branch.providerId, funding: req.funding ?? branch.funding };
    if (learn && route.providerId !== branch.providerId)
      throw new ValidationError("Compare runs on the lesson's own provider");
    if (learn) route.funding = branch.funding;
    // The client picks the model, so the allowlist is what bounds it (Learn: its tiers).
    // The context is resolved like a send on the branch, so missing summaries are
    // generated on the branch's route: its credit is checked too. Never on the pool (403).
    await assertCanGenerate(c, {
      purpose: 'compare',
      ...route,
      model: req.model,
      alsoSpendsOn: { providerId: branch.providerId, funding: branch.funding },
      keys,
      content: req.content,
    });
    chat = chatOf(c, keys, true);
    // Power's reply length and input limit, clamped like a send's on the candidate's
    // route; Learn takes none (input-limit.ts).
    const prepared = await chat.prepareCandidate(
      branch.id,
      req,
      generationLimits(c.env, c.var.account, route.funding, req),
    );
    await assertCreditCoversReply(c, chat, prepared);
    const accountId = c.var.account.id;

    /** The wire `done`: the candidate, once the Durable Object holds it for the commit. */
    const hold = async (candidate: HeldCandidate): Promise<CandidateEvent> => {
      try {
        const res = await treeSession(c.env, branch.treeId).holdCandidate({
          candidate,
          accountId,
        });
        if (!res.ok) throw new Error(`hold-candidate answered ${res.status}`);
        const { expiresAt } = (await res.json()) as SessionHoldResponse;
        return {
          type: 'done',
          candidateId: candidate.id,
          providerId: candidate.providerId,
          funding: candidate.funding,
          model: candidate.model,
          usage: candidate.usage,
          sources: candidate.sources,
          expiresAt,
        };
      } catch (err) {
        logEvent('error', 'candidate_hold_failed', { error: err });
        return { type: 'error', message: 'This answer could not be kept; try again.' };
      }
    };
    return sseFromAsyncIterable(c, chat.runCandidate(prepared, c.req.raw.signal), (event) =>
      event.type === 'done' ? hold(event.candidate) : event,
    );
  });
  // Appends the picked candidate (the server's copy, so the model and usage are
  // real). It may auto-title the branch, a model call, so the user's keys ride
  // along sealed, as for a send. 403 on the open pool, where compare is refused.
  api.post('/branches/:branchId/candidates/:candidateId/commit', async (c) => {
    const branch = await chatOf(c).getOwnedBranch(c.req.param('branchId'));
    const { account } = c.var;
    if (account.mode === 'simple' && account.payer === 'pool')
      throw new DomainError('pool_unavailable', "Compare isn't available on the open pool");
    const keys = await keysOf(c);
    const body: SessionCommitBody = {
      candidateId: c.req.param('candidateId'),
      branchId: branch.id,
      account: c.var.account,
      ...(keys ? { sealedKeys: keys.sealed } : {}),
    };
    return treeSession(c.env, branch.treeId).commitCandidate(body);
  });

  return api;
}
