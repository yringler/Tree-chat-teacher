import { computed, signal } from '@angular/core';
// The tree helpers only: the rest of @tangent/core (the ChatService) is for the lazy demo chunk.
import { indexTree, type TreeIndex } from '@tangent/core/tree';
import type { Branch, ChatNode, NodeLink, StreamEvent, TreeDetail } from '@tangent/shared';
import type { ApiClient } from '../core/api-client';
import { runStream, type StreamOutcome } from '../sse/stream-runner';

/** Live state of a reply, kept apart from `detail` so deltas don't re-index the tree. */
export interface LiveReply {
  nodeId: string;
  treeId: string;
  branchId: string;
  content: string;
  /** Latest `status` event (e.g. "Summarizing parent context…"). */
  status: string | null;
  reconnecting: boolean;
}

/** The server calls the conversation engine makes. */
export type ConversationApi = Pick<ApiClient, 'streamNode'>;

function upsertById<T extends { id: string }>(list: readonly T[], items: readonly T[]): T[] {
  const out = [...list];
  for (const item of items) {
    const i = out.findIndex((x) => x.id === item.id);
    if (i === -1) out.push(item);
    else out[i] = item;
  }
  return out;
}

/**
 * The conversation engine the apps' stores are built on (power's TreeStore,
 * the canvas's CanvasStore, Learn's LessonStore): the open tree and its
 * index, and every live reply. Any number of branches may generate at once
 * (the server only refuses a send into a branch whose leaf is still
 * streaming), and `live` holds them all. Plain signals and no DI, so it can
 * be unit tested; each app extends it with its own state and side effects.
 */
export abstract class ConversationStore<A extends ConversationApi = ConversationApi> {
  readonly detail = signal<TreeDetail | null>(null);
  readonly live = signal<ReadonlyMap<string, LiveReply>>(new Map());
  protected readonly controllers = new Map<string, AbortController>();

  readonly index = computed<TreeIndex | null>(() => {
    const d = this.detail();
    if (!d) return null;
    try {
      return indexTree(d.branches, d.nodes);
    } catch (err) {
      console.error('indexTree failed', err);
      return null;
    }
  });

  constructor(protected readonly api: A) {}

  /** A reply's stream ended (`nodeId` null: it never started). */
  protected abstract finish(nodeId: string | null, outcome: StreamOutcome): void;

  /** After loading a tree: re-attach to replies still generating server-side. */
  protected resumeStreaming(nodes: readonly ChatNode[]): void {
    for (const n of nodes) {
      if (n.status !== 'streaming' || n.role !== 'assistant' || this.controllers.has(n.id))
        continue;
      const ctrl = new AbortController();
      this.controllers.set(n.id, ctrl);
      this.setLive({
        nodeId: n.id,
        treeId: n.treeId,
        branchId: n.branchId,
        content: n.content,
        status: null,
        reconnecting: false,
      });
      void runStream(
        { open: null, reconnect: (id, signal) => this.api.streamNode(id, signal) },
        (event) => this.apply(event, n.id),
        { nodeId: n.id, signal: ctrl.signal, baseDelayMs: 1000 },
      )
        .then((outcome) => this.finish(n.id, outcome))
        .finally(() => this.controllers.delete(n.id));
    }
  }

  /** One stream event into the tree and `live`; `streamNodeId` is the reply it is about, once known. */
  protected apply(event: StreamEvent, streamNodeId: string | null): void {
    switch (event.type) {
      case 'start':
        this.applyNodes([event.userNode, event.assistantNode]);
        this.applyBranch(event.branch);
        this.setLive({
          nodeId: event.assistantNode.id,
          treeId: event.assistantNode.treeId,
          branchId: event.assistantNode.branchId,
          content: event.assistantNode.content,
          status: null,
          reconnecting: false,
        });
        break;
      case 'snapshot':
        this.patchLive(event.node.id, { content: event.node.content, reconnecting: false });
        if (event.node.status !== 'streaming') this.applyNodes([event.node]);
        break;
      case 'status':
        if (streamNodeId) this.patchLive(streamNodeId, { status: event.message });
        break;
      case 'delta': {
        const s = this.live().get(event.nodeId);
        if (s)
          this.patchLive(event.nodeId, {
            content: s.content + event.text,
            status: null,
            reconnecting: false,
          });
        break;
      }
      case 'usage':
        break;
      case 'done':
        this.applyNodes([event.node]);
        this.applyBranch(event.branch);
        this.dropLive(event.node.id);
        break;
      case 'error':
        if (event.node) this.applyNodes([event.node]);
        else if (event.nodeId) this.markError(event.nodeId, event.message);
        if (event.nodeId) this.dropLive(event.nodeId);
        break;
    }
  }

  /** Marks a reply failed, keeping the text it streamed. */
  protected markError(nodeId: string, message: string): void {
    const node = this.index()?.nodes.get(nodeId);
    if (node)
      this.applyNodes([
        {
          ...node,
          status: 'error',
          error: message,
          content: this.live().get(nodeId)?.content ?? node.content,
        },
      ]);
  }

  /** Nodes into the open tree (those of another tree, opened meanwhile, are dropped). */
  protected applyNodes(nodes: ChatNode[]): void {
    this.detail.update((d) => {
      if (!d) return d;
      const mine = nodes.filter((n) => n.treeId === d.tree.id);
      return mine.length ? { ...d, nodes: upsertById(d.nodes, mine) } : d;
    });
  }

  protected applyBranch(branch: Branch): void {
    this.detail.update((d) =>
      d && d.tree.id === branch.treeId ? { ...d, branches: upsertById(d.branches, [branch]) } : d,
    );
  }

  protected applyLinks(links: NodeLink[]): void {
    this.detail.update((d) => {
      if (!d) return d;
      const mine = links.filter((l) => l.treeId === d.tree.id);
      return mine.length ? { ...d, links: upsertById(d.links, mine) } : d;
    });
  }

  /** Stops following the replies of a deleted tree (the server has no tree to stream them from). */
  protected stopTreeStreams(treeId: string): void {
    for (const l of this.live().values()) {
      if (l.treeId !== treeId) continue;
      this.stopFollowing(l.nodeId);
    }
  }

  /** Stops following one reply (its tree or branch is gone). */
  protected stopFollowing(nodeId: string): void {
    this.controllers.get(nodeId)?.abort();
    this.controllers.delete(nodeId);
    this.dropLive(nodeId);
  }

  protected setLive(s: LiveReply): void {
    this.live.update((m) => new Map(m).set(s.nodeId, s));
  }

  protected patchLive(nodeId: string, patch: Partial<LiveReply>): void {
    const cur = this.live().get(nodeId);
    if (cur) this.setLive({ ...cur, ...patch });
  }

  protected dropLive(nodeId: string): void {
    if (!this.live().has(nodeId)) return;
    this.live.update((m) => {
      const next = new Map(m);
      next.delete(nodeId);
      return next;
    });
  }
}
