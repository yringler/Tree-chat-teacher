import { DomainError, HTTP_STATUS, KeyRequiredError, type BeginSendResult, type ChatService } from '@tangent/core';
import type { ApiError, ChatNode, StreamEvent } from '@tangent/shared';
import { DurableObject } from 'cloudflare:workers';
import { openKeys } from '../byok/keys.js';
import type { AppEnv } from '../env.js';
import { sseFrame, sseKeepAliveFrame, sseResponse } from '../http/sse.js';
import { chatService } from '../services.js';

const KEEPALIVE_MS = 15_000;
const encoder = new TextEncoder();

/** Body of the internal POST /send. `sealedKeys` is the user's key cookie, still sealed. */
export interface SessionSendBody {
  content: string;
  sealedKeys?: string;
}

interface Run {
  /** Assistant node with content accumulated so far (for reconnect snapshots). */
  node: ChatNode;
  subscribers: Set<WritableStreamDefaultWriter<Uint8Array>>;
  controller: AbortController;
}

/**
 * One instance per tree (idFromName(treeId)). Owns every generation in the
 * tree so it keeps running when the browser disconnects, lets clients
 * reconnect with a snapshot, and serializes sends per tree.
 *
 * Internal protocol (called only by the Worker, never exposed):
 *   POST /send?treeId=&branchId=   body SessionSendBody → SSE
 *   GET  /stream?treeId=&nodeId=                    → SSE (snapshot, then live)
 *   POST /cancel?treeId=&nodeId=                    → 204
 */
export class TreeSession extends DurableObject<AppEnv> {
  private readonly runs = new Map<string, Run>();
  private recovered = false;
  /** Serializes beginSend within this tree. */
  private sendLock: Promise<unknown> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const treeId = url.searchParams.get('treeId') ?? '';
    const chat = chatService(this.env);
    try {
      await this.recoverOnce(chat, treeId);
      if (request.method === 'POST' && url.pathname === '/send') {
        const { content, sealedKeys } = (await request.json()) as SessionSendBody;
        // Keys stay in memory only for this generation (the ChatService closes over them).
        const keys = await openKeys(sealedKeys, this.env);
        if (keys.state === 'invalid') throw new KeyRequiredError('Your stored API key could not be read. Enter it again.');
        const sendChat = keys.state === 'ok' ? chatService(this.env, undefined, keys.keys) : chat;
        return await this.send(sendChat, url.searchParams.get('branchId') ?? '', content);
      }
      if (request.method === 'GET' && url.pathname === '/stream') {
        return await this.reconnect(chat, url.searchParams.get('nodeId') ?? '');
      }
      if (request.method === 'POST' && url.pathname === '/cancel') {
        return await this.cancel(chat, treeId, url.searchParams.get('nodeId') ?? '');
      }
      return errorResponse('not_found', 'Unknown session route');
    } catch (err) {
      if (err instanceof DomainError) return errorResponse(err.code, err.message);
      console.error('TreeSession error', err);
      return errorResponse('internal', 'Internal error');
    }
  }

  /** A fresh instance (first request, or after eviction/redeploy) owns no runs: stale `streaming` nodes are orphans. */
  private async recoverOnce(chat: ChatService, treeId: string): Promise<void> {
    if (this.recovered || !treeId) return;
    this.recovered = true;
    if (this.runs.size === 0) await chat.recoverInterrupted(treeId);
  }

  private async send(chat: ChatService, branchId: string, content: string): Promise<Response> {
    const begin = this.sendLock.then(() => chat.beginSend(branchId, content));
    this.sendLock = begin.catch(() => undefined);
    const started: BeginSendResult = await begin;

    const run: Run = {
      node: { ...started.assistantNode },
      subscribers: new Set(),
      controller: new AbortController(),
    };
    this.runs.set(started.assistantNode.id, run);
    const response = this.subscribe(run, [
      { type: 'start', userNode: started.userNode, assistantNode: started.assistantNode, branch: started.branch },
    ]);
    // Detached: keeps running after the client disconnects (DOs stay alive while I/O is in flight).
    this.ctx.waitUntil(this.pump(chat, run, started));
    return response;
  }

  private async pump(chat: ChatService, run: Run, begin: BeginSendResult): Promise<void> {
    const keepalive = setInterval(() => this.broadcastRaw(run, sseKeepAliveFrame()), KEEPALIVE_MS);
    try {
      for await (const event of chat.runGeneration(begin, run.controller.signal)) {
        if (event.type === 'delta') run.node = { ...run.node, content: run.node.content + event.text };
        if (event.type === 'done' || event.type === 'error') {
          if (event.node) run.node = event.node;
        }
        this.broadcastRaw(run, sseFrame(event));
      }
    } finally {
      clearInterval(keepalive);
      this.runs.delete(begin.assistantNode.id);
      for (const writer of run.subscribers) writer.close().catch(() => undefined);
      run.subscribers.clear();
    }
  }

  private async reconnect(chat: ChatService, nodeId: string): Promise<Response> {
    const run = this.runs.get(nodeId);
    if (run) return this.subscribe(run, [{ type: 'snapshot', node: run.node }]);

    // Not running here: serve the persisted final state.
    const repo = chat.deps.repos.trees;
    const node = await repo.getNode(nodeId);
    if (!node) return errorResponse('not_found', 'Node not found');
    let final = node;
    if (node.status === 'streaming') {
      await chat.recoverInterrupted(node.treeId);
      final = (await repo.getNode(nodeId)) ?? node;
    }
    const branch = await repo.getBranch(final.branchId);
    const events: StreamEvent[] = [{ type: 'snapshot', node: final }];
    if (final.status === 'complete' && branch) events.push({ type: 'done', node: final, branch });
    else events.push({ type: 'error', nodeId: final.id, message: final.error ?? 'Generation failed', node: final });
    return sseResponse(streamOf(events.map(sseFrame).join('')));
  }

  private async cancel(chat: ChatService, treeId: string, nodeId: string): Promise<Response> {
    const run = this.runs.get(nodeId);
    if (run) run.controller.abort();
    else if (treeId) await chat.recoverInterrupted(treeId);
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

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function errorResponse(code: ApiError['error']['code'], message: string): Response {
  return Response.json({ error: { code, message } } satisfies ApiError, { status: HTTP_STATUS[code] });
}
