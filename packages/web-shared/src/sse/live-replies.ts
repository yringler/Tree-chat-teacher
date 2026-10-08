import { computed, signal, untracked, type Signal, type WritableSignal } from '@angular/core';

/** Live state of a generation, kept apart from the tree so deltas don't re-index it. */
export interface LiveReply {
  nodeId: string;
  treeId: string;
  branchId: string;
  content: string;
  /** Latest `status` event (e.g. "Summarizing parent context…"). */
  status: string | null;
  reconnecting: boolean;
}

/** What a stream event changes in a live reply (never which reply, or where it is). */
export type LiveReplyPatch = Partial<Pick<LiveReply, 'content' | 'status' | 'reconnecting'>>;

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/**
 * The replies being generated, by assistant node id, each in a signal of its
 * own: a delta only notifies the readers of that reply (the one message
 * showing it), not every message and outline row. The map of them changes
 * only when a reply starts or ends, and so does `branchIds`.
 */
export class LiveReplies {
  private readonly map = signal<ReadonlyMap<string, WritableSignal<LiveReply>>>(new Map());

  /** Every live reply, by node id. Changes when one starts or ends, not per delta. */
  readonly all: Signal<ReadonlyMap<string, Signal<LiveReply>>> = this.map.asReadonly();

  /** Branches with a reply generating. Changes only when a reply starts or ends. */
  readonly branchIds = computed<ReadonlySet<string>>(
    () => {
      const set = new Set<string>();
      // A reply's branch never changes: read it untracked, so deltas don't reach this.
      for (const s of this.map().values()) set.add(untracked(s).branchId);
      return set;
    },
    { equal: sameSet },
  );

  /** The reply on `nodeId`, or null. Tracks that reply only (and its start and end). */
  get(nodeId: string): LiveReply | null {
    return this.map().get(nodeId)?.() ?? null;
  }

  /** `get` without tracking, for the store's own updates. */
  peek(nodeId: string): LiveReply | null {
    return untracked(() => this.get(nodeId));
  }

  /** Starts following a reply, or replaces the state of one already followed. */
  set(reply: LiveReply): void {
    const cur = untracked(this.map).get(reply.nodeId);
    if (cur) cur.set(reply);
    else this.map.update((m) => new Map(m).set(reply.nodeId, signal(reply)));
  }

  /** Updates a followed reply; does nothing for one that isn't. */
  patch(nodeId: string, patch: LiveReplyPatch): void {
    untracked(this.map)
      .get(nodeId)
      ?.update((cur) => ({ ...cur, ...patch }));
  }

  /** Stops following a reply (it finished, failed or is gone). */
  drop(nodeId: string): void {
    if (!untracked(this.map).has(nodeId)) return;
    this.map.update((m) => {
      const next = new Map(m);
      next.delete(nodeId);
      return next;
    });
  }
}
