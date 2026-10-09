import {
  DomainError,
  GoneError,
  HTTP_STATUS,
  KeyRequiredError,
  NotFoundError,
  PoolBlockedError,
  pickGenerationLimits,
  poolBlock,
  type BeginSendResult,
  type ChatService,
  type GenerationLimits,
  type HeldCandidate,
} from '@tangent/core';
import {
  CANDIDATE_TTL_MS,
  OPENROUTER_PROVIDER_ID,
  type ApiError,
  type ChatNode,
  type CommitCandidateResponse,
  type StreamEvent,
} from '@tangent/shared';
import { DurableObject } from 'cloudflare:workers';
import { openKeys } from '../byok/keys.js';
import { reserveCreditReply } from '../billing/service.js';
import { releaseUndispatched } from '../billing/usage-store.js';
import {
  callPayer,
  isPoolFunded,
  type AccountContext,
  type AppEnv,
  type PoolAccount,
} from '../env.js';
import { apiErrorBody } from '../http/errors.js';
import { sseFrame, sseKeepAliveFrame, sseResponse } from '../http/sse.js';
import { poolBank } from '../pool/ids.js';
import { poolBlockDetails, poolReserveRequest, replyCeilingMicros } from '../pool/params.js';
import { chatService } from '../registries.js';
import { accountFromParams, parseAccount } from './tree-session-client.js';
import { logEvent } from '../log.js';

const KEEPALIVE_MS = 15_000;
const encoder = new TextEncoder();

/**
 * Body of the internal POST /send. `sealedKeys` is the user's key cookie,
 * still sealed (never sent by Learn on credit). `account` is the caller's account as
 * the Worker resolved it; the DO trusts it (its routes are internal) and the
 * Worker has already checked that the branch belongs to it.
 */
export interface SessionSendBody extends GenerationLimits {
  content: string;
  /** "Check sources": the reply must run a web search. */
  ground?: 'required';
  // GenerationLimits: power's reply length and input limit, as the Worker clamped them.
  account: AccountContext;
  sealedKeys?: string;
  /** A reply on Tangent credit: what to reserve before any node is written. */
  creditReply?: CreditReplyHold;
}

/** The reservation of a reply on Tangent credit, as the Worker priced it (routes/generation.ts). */
export interface CreditReplyHold {
  providerId: string;
  model: string;
  /** The reply's worst case before its prompt exists (`replyHoldMicros`). */
  holdMicros: number;
}

/**
 * Body of the internal POST /hold-candidate: a finished compare candidate
 * (`ChatService.runCandidate`), held for `accountId` until it is committed or
 * expires.
 */
export interface SessionHoldBody {
  candidate: HeldCandidate;
  accountId: string;
}

/** What POST /hold-candidate answers: when the held candidate expires (ISO). */
export interface SessionHoldResponse {
  expiresAt: string;
}

/**
 * Body of the internal POST /commit-candidate. `account` and `sealedKeys` as
 * in SessionSendBody (a commit may auto-title the branch, which calls a model).
 */
export interface SessionCommitBody {
  candidateId: string;
  branchId: string;
  account: AccountContext;
  sealedKeys?: string;
}

/** A held candidate in this DO's storage, under `candidate:<id>`. */
interface HeldEntry {
  candidate: HeldCandidate;
  accountId: string;
  /** Epoch ms after which it can no longer be committed. */
  expiresAt: number;
}

const CANDIDATE_PREFIX = 'candidate:';

/** What a send writes and generates (with power's limits), and its credit reservation if any. */
interface SendTarget extends GenerationLimits {
  treeId: string;
  branchId: string;
  content: string;
  ground?: 'required';
  creditReply?: CreditReplyHold;
}

interface Run {
  /** Assistant node with content accumulated so far (for reconnect snapshots). */
  node: ChatNode;
  subscribers: Set<WritableStreamDefaultWriter<Uint8Array>>;
  controller: AbortController;
  /** Settles when the generation has finished and persisted its final state. */
  finished: Promise<void>;
}

/**
 * One instance per tree (idFromName(treeId)). Owns every generation in the
 * tree so it keeps running when the browser disconnects, lets clients
 * reconnect with a snapshot, and serializes sends per tree.
 *
 * Internal protocol (called only by the Worker, never exposed; `&account`
 * is accountParams() of tree-session-client.ts, i.e. `account=<AccountContext as JSON>`):
 *   POST /send?treeId=&branchId=   body SessionSendBody → SSE
 *   GET  /stream?treeId=&nodeId=&account            → SSE (snapshot, then live)
 *   POST /cancel?treeId=&nodeId=&account            → 204
 *   POST /delete-branch?treeId=&branchId=&account   → DeleteBranchResponse
 *   POST /delete-tree?treeId=&account               → 204
 *   POST /hold-candidate?treeId=     body SessionHoldBody → SessionHoldResponse
 *   POST /commit-candidate?treeId=   body SessionCommitBody → CommitCandidateResponse
 * The Worker resolves every branch/node id through the caller's account
 * before calling in, so the DO doesn't re-check ownership except where the
 * ChatService does it anyway (beginSend, deleteBranch, deleteTree,
 * commitCandidate).
 *
 * Compare candidates stream from the Worker (like reviews), never through a
 * run here: a finished one is only held in this DO's storage for
 * `CANDIDATE_TTL_MS` (the alarm prunes expired entries), and a commit
 * appends it under the send lock, so it can't interleave with a send. A
 * commit drops the candidate and its siblings (the other answers to the same
 * question); an uncommitted one simply expires.
 */
export class TreeSession extends DurableObject<AppEnv> {
  private readonly runs = new Map<string, Run>();
  private recovered = false;
  /** Serializes beginSend (and branch deletion, and candidate commits) within this tree. */
  private sendLock: Promise<unknown> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const treeId = url.searchParams.get('treeId') ?? '';
    try {
      if (request.method === 'POST' && url.pathname === '/send') {
        const sent = (await request.json()) as SessionSendBody;
        const body = { ...sent, account: parseAccount(sent.account) };
        const { content, ground, account, creditReply } = body;
        await this.recoverOnce(chatService(this.env, account), treeId);
        const chat = await this.generatingChat(body);
        return await this.send(chat, account, {
          treeId,
          branchId: url.searchParams.get('branchId') ?? '',
          content,
          ...(ground === 'required' ? { ground } : {}),
          ...(creditReply ? { creditReply } : {}),
          ...pickGenerationLimits(body),
        });
      }
      if (request.method === 'POST' && url.pathname === '/hold-candidate') {
        return await this.holdCandidate((await request.json()) as SessionHoldBody);
      }
      if (request.method === 'POST' && url.pathname === '/commit-candidate') {
        const sent = (await request.json()) as SessionCommitBody;
        const body = { ...sent, account: parseAccount(sent.account) };
        await this.recoverOnce(chatService(this.env, body.account), treeId);
        return await this.commitCandidate(await this.generatingChat(body), body);
      }
      const chat = chatService(this.env, accountFromParams(url.searchParams));
      await this.recoverOnce(chat, treeId);
      if (request.method === 'GET' && url.pathname === '/stream') {
        return await this.reconnect(chat, url.searchParams.get('nodeId') ?? '');
      }
      if (request.method === 'POST' && url.pathname === '/cancel') {
        return await this.cancel(chat, url.searchParams.get('nodeId') ?? '');
      }
      if (request.method === 'POST' && url.pathname === '/delete-branch') {
        return await this.deleteBranch(chat, url.searchParams.get('branchId') ?? '');
      }
      if (request.method === 'POST' && url.pathname === '/delete-tree') {
        return await this.deleteTree(chat, treeId);
      }
      return errorResponse(new DomainError('not_found', 'Unknown session route'));
    } catch (err) {
      if (err instanceof DomainError) return errorResponse(err);
      logEvent('error', 'tree_session_error', { error: err });
      return errorResponse(new DomainError('internal', 'Internal error'));
    }
  }

  /**
   * The ChatService of a request that may call a model (a send, a commit's
   * auto-title), as `account`, with the user's keys opened from the still-sealed
   * cookie value. Learn on credit never uses the user's own keys (the Worker
   * doesn't send them either).
   */
  private async generatingChat(body: {
    account: AccountContext;
    sealedKeys?: string;
  }): Promise<ChatService> {
    const { account, sealedKeys } = body;
    const keys =
      callPayer(account, 'own-key') === 'own-key'
        ? await openKeys(sealedKeys, this.env, account.userId)
        : null;
    if (keys?.state === 'invalid')
      throw new KeyRequiredError('Your stored API key could not be read. Enter it again.');
    // Keys stay in memory only for this generation (the ChatService closes over them).
    return chatService(this.env, account, {
      ...(keys?.state === 'ok' ? { apiKeys: keys.keys } : {}),
      // The usage meter (built-in provider) settles or reconciles after the stream ends.
      defer: (p) => this.ctx.waitUntil(p),
      generating: true,
    });
  }

  /** A fresh instance (first request, or after eviction/redeploy) owns no runs: stale `streaming` nodes are orphans. */
  private async recoverOnce(chat: ChatService, treeId: string): Promise<void> {
    if (this.recovered || !treeId) return;
    this.recovered = true;
    if (this.runs.size === 0) await chat.recoverInterrupted(treeId);
  }

  /**
   * On the pool or on Tangent credit, the reply is reserved (the pool's
   * ceiling hold, credit's worst case as the Worker priced it) under the send lock before `beginSend`
   * writes any node, so a refusal is a plain 402/429 and the branch is
   * untouched. The reservation is released whenever the reply never reaches
   * the provider: `beginSend` fails, or the run ends without dispatching it.
   */
  private async send(
    chat: ChatService,
    account: AccountContext,
    target: SendTarget,
  ): Promise<Response> {
    const begin = this.sendLock.then(async () => {
      const credit = target.creditReply;
      const reservationId = isPoolFunded(account)
        ? await this.reserveReply(account, target)
        : credit
          ? await reserveCreditReply(this.env, account, { ...target, ...credit }, credit.holdMicros)
          : null;
      try {
        return { started: await chat.beginSend(target.branchId, target.content), reservationId };
      } catch (err) {
        if (reservationId) await this.release(reservationId);
        throw err;
      }
    });
    this.sendLock = begin.catch(() => undefined);
    const { started, reservationId } = await begin;

    const run: Run = {
      node: { ...started.assistantNode },
      subscribers: new Set(),
      controller: new AbortController(),
      finished: Promise.resolve(),
    };
    this.runs.set(started.assistantNode.id, run);
    const response = this.subscribe(run, [
      {
        type: 'start',
        userNode: started.userNode,
        assistantNode: started.assistantNode,
        branch: started.branch,
        // Who pays, as the gate decided: a Learn send may have moved from credit to the pool.
        funding: callPayer(account, started.branch.funding),
      },
    ]);
    // Detached: keeps running after the client disconnects (DOs stay alive while I/O is in flight).
    run.finished = this.pump(chat, run, started, reservationId, target);
    this.ctx.waitUntil(run.finished);
    return response;
  }

  /** Reserves the reply's ceiling hold on the pool, or throws `PoolBlockedError`. */
  private async reserveReply(
    { pool, userId }: PoolAccount,
    target: { treeId: string; branchId: string },
  ): Promise<string> {
    if (!pool.price) throw new PoolBlockedError(poolBlock('unpriced'));
    const result = await poolBank(this.env, pool.accountId).reserve(
      poolReserveRequest(pool, userId, {
        purpose: 'reply',
        treeId: target.treeId,
        branchId: target.branchId,
        nodeId: null,
        providerId: OPENROUTER_PROVIDER_ID,
        holdMicros: replyCeilingMicros(pool, pool.price),
        feeBps: pool.price.feeBps,
      }),
    );
    if (!result.ok) throw new PoolBlockedError(poolBlockDetails(result));
    return result.usageId;
  }

  /**
   * Releases an undispatched reservation; a failure is left to the backstops
   * (PoolBank's expiry, the reconcile cron).
   */
  private async release(reservationId: string): Promise<void> {
    try {
      await releaseUndispatched(this.env.DB, reservationId);
    } catch (err) {
      logEvent('error', 'reservation_release_failed', { reservationId, error: err });
    }
  }

  /**
   * Holds the send lock so no message lands in the doomed branches, cancels
   * their generations and waits for them to persist, then deletes.
   */
  private async deleteBranch(chat: ChatService, branchId: string): Promise<Response> {
    const deleted = this.sendLock.then(() =>
      chat.deleteBranch(branchId, {
        stopGenerations: async (branchIds) => {
          const doomed = [...this.runs.values()].filter((r) => branchIds.has(r.node.branchId));
          for (const run of doomed) run.controller.abort();
          await Promise.all(doomed.map((r) => r.finished));
        },
      }),
    );
    this.sendLock = deleted.catch(() => undefined);
    return Response.json(await deleted);
  }

  /**
   * Like `deleteBranch`, for the whole tree; then drops everything this DO
   * stores for it (held candidates hold the user's question and answers).
   */
  private async deleteTree(chat: ChatService, treeId: string): Promise<Response> {
    const deleted = this.sendLock.then(async () => {
      await chat.deleteTree(treeId, {
        stopGenerations: async () => {
          const runs = [...this.runs.values()];
          for (const run of runs) run.controller.abort();
          await Promise.all(runs.map((r) => r.finished));
        },
      });
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    });
    this.sendLock = deleted.catch(() => undefined);
    await deleted;
    return new Response(null, { status: 204 });
  }

  /** Holds a finished candidate for `CANDIDATE_TTL_MS`. */
  private async holdCandidate(body: SessionHoldBody): Promise<Response> {
    const now = Date.now();
    const entry: HeldEntry = { ...body, expiresAt: now + CANDIDATE_TTL_MS };
    await this.ctx.storage.put(CANDIDATE_PREFIX + body.candidate.id, entry);
    await this.pruneCandidates(now);
    return Response.json({
      expiresAt: new Date(entry.expiresAt).toISOString(),
    } satisfies SessionHoldResponse);
  }

  /** Unpicked candidates (the user's question and answers) go when they expire. */
  override async alarm(): Promise<void> {
    await this.pruneCandidates(Date.now());
  }

  /** Deletes the expired held candidates and sets the alarm for the next expiry, if any. */
  private async pruneCandidates(now: number): Promise<void> {
    const storage = this.ctx.storage;
    const held = await storage.list<HeldEntry>({ prefix: CANDIDATE_PREFIX });
    const expired: string[] = [];
    let next: number | null = null;
    for (const [key, entry] of held) {
      if (entry.expiresAt <= now) expired.push(key);
      else if (next === null || entry.expiresAt < next) next = entry.expiresAt;
    }
    await deleteKeys(storage, expired);
    if (next === null) await storage.deleteAlarm();
    else await storage.setAlarm(next);
  }

  /**
   * Appends a held candidate to its branch under the send lock (no send can
   * slip in between the check that the branch hasn't moved on and the
   * append): 410 when it expired or is gone, 404 when it isn't this
   * account's or this branch's, 409 (ChatService) when the branch moved on.
   * The candidate and its siblings are dropped once it is in the tree. The
   * auto-title of a first exchange (a model call) runs after the lock is
   * released, so other sends in the tree don't wait on it.
   */
  private async commitCandidate(chat: ChatService, body: SessionCommitBody): Promise<Response> {
    const storage = this.ctx.storage;
    const key = CANDIDATE_PREFIX + body.candidateId;
    const committed = this.sendLock.then(async () => {
      const entry = await storage.get<HeldEntry>(key);
      if (!entry || entry.expiresAt <= Date.now()) {
        if (entry) await storage.delete(key);
        throw new GoneError('This comparison expired. Ask again.');
      }
      if (entry.accountId !== body.account.id || entry.candidate.branchId !== body.branchId)
        throw new NotFoundError('Candidate');
      const result = await chat.appendCandidate(entry.candidate);
      const { branchId, parentId } = entry.candidate;
      const held = await storage.list<HeldEntry>({ prefix: CANDIDATE_PREFIX });
      const done = [...held]
        .filter(
          ([, other]) =>
            other.candidate.branchId === branchId && other.candidate.parentId === parentId,
        )
        .map(([k]) => k);
      await deleteKeys(storage, [...new Set([key, ...done])]);
      return result;
    });
    this.sendLock = committed.catch(() => undefined);
    const result = await committed;
    return Response.json({
      ...result,
      branch: await chat.titleCommitted(result),
    } satisfies CommitCandidateResponse);
  }

  /**
   * Runs the generation and broadcasts it. `reservationId` is the pool
   * reservation of the reply, if any.
   */
  private async pump(
    chat: ChatService,
    run: Run,
    begin: BeginSendResult,
    reservationId: string | null,
    { ground, ...limits }: Pick<SendTarget, 'ground'> & GenerationLimits = {},
  ): Promise<void> {
    const keepalive = setInterval(() => this.broadcastRaw(run, sseKeepAliveFrame()), KEEPALIVE_MS);
    try {
      const options = {
        ...(reservationId ? { reservationId } : {}),
        ...(ground ? { ground } : {}),
        ...pickGenerationLimits(limits),
      };
      for await (const event of chat.runGeneration(begin, run.controller.signal, options)) {
        if (event.type === 'delta')
          run.node = { ...run.node, content: run.node.content + event.text };
        if ((event.type === 'done' || event.type === 'error') && event.node) run.node = event.node;
        this.broadcastRaw(run, sseFrame(event));
      }
    } finally {
      clearInterval(keepalive);
      // The reply never reached the provider (the meter settles a dispatched one).
      if (reservationId) await this.release(reservationId);
      this.runs.delete(begin.assistantNode.id);
      for (const writer of run.subscribers) writer.close().catch(() => undefined);
      run.subscribers.clear();
    }
  }

  private async reconnect(chat: ChatService, nodeId: string): Promise<Response> {
    const run = this.runs.get(nodeId);
    if (run) return this.subscribe(run, [{ type: 'snapshot', node: run.node }]);

    // Not running here: serve the persisted final state. Still `streaming`
    // means an orphan; only it is recovered (other branches may be live).
    const final = await chat.recoverInterruptedNode(nodeId);
    if (!final) return errorResponse(new DomainError('not_found', 'Node not found'));
    const branch = await chat.deps.repos.trees.getBranch(final.branchId);
    const events: StreamEvent[] = [{ type: 'snapshot', node: final }];
    if (final.status === 'complete' && branch) events.push({ type: 'done', node: final, branch });
    else
      events.push({
        type: 'error',
        nodeId: final.id,
        message: final.error ?? 'Generation failed',
        node: final,
      });
    return sseResponse(streamOf(events.map(sseFrame).join('')));
  }

  /** Without a run here the node is finished or an orphan: only that node is recovered. */
  private async cancel(chat: ChatService, nodeId: string): Promise<Response> {
    const run = this.runs.get(nodeId);
    if (run) run.controller.abort();
    else await chat.recoverInterruptedNode(nodeId);
    return new Response(null, { status: 204 });
  }

  private subscribe(run: Run, initial: StreamEvent[]): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const drop = () => run.subscribers.delete(writer);
    writer.write(encoder.encode(initial.map(sseFrame).join(''))).catch(drop);
    run.subscribers.add(writer);
    return sseResponse(readable);
  }

  private broadcastRaw(run: Run, frame: string): void {
    const bytes = encoder.encode(frame);
    for (const writer of run.subscribers) {
      // A failed write means the client went away; the generation continues regardless.
      writer.write(bytes).catch(() => run.subscribers.delete(writer));
    }
  }
}

/** Storage deletes take at most 128 keys at a time. */
const DELETE_BATCH = 128;

async function deleteKeys(storage: DurableObjectStorage, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH)
    await storage.delete(keys.slice(i, i + DELETE_BATCH));
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** The Worker passes the status and body through (pool refusals carry `error.pool`). */
function errorResponse(err: DomainError): Response {
  return Response.json(apiErrorBody(err) satisfies ApiError, { status: HTTP_STATUS[err.code] });
}
