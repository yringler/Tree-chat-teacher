import type { Branch, ChatNode, Payer, StreamEvent } from '@tangent/shared';
import type { BeginSendResult } from './send.js';

/**
 * One reader of a generation: the Worker's response stream to one client,
 * or the demo's. A write that throws or rejects means the reader went away:
 * it is dropped, and the generation goes on without it.
 */
export interface GenerationSink {
  write(event: StreamEvent): void | Promise<void>;
  close(): void | Promise<void>;
  /** Keeps an idle transport open between events (an SSE comment), where it needs that. */
  ping?(): void | Promise<void>;
}

export interface GenerationHubOptions {
  /** How often an idle run pings its readers; none without it. */
  keepAliveMs?: number;
}

/** What a run does once its generation has ended, before its readers are closed. */
export interface RunOptions {
  settle?: () => void | Promise<void>;
}

interface Run {
  /** The assistant node with the content so far: the snapshot a reconnecting reader starts from. */
  node: ChatNode;
  sinks: Set<GenerationSink>;
  controller: AbortController;
  /** Settles when the generation has ended and stored its final state. */
  finished: Promise<void>;
}

/**
 * The generations running in one tree, fanned out to their readers. A
 * generation runs detached from the request that started it, so it keeps
 * going when the reader disconnects; a reader can attach again and starts
 * from a snapshot. Runtime-neutral: the Worker's TreeSession Durable Object
 * and the in-browser demo each bring their own sinks.
 */
export class GenerationHub {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly options: GenerationHubOptions = {}) {}

  /** How many generations are running. */
  get size(): number {
    return this.runs.size;
  }

  /**
   * Runs the reply `begin` started: `sink` gets the `start` event (which
   * says who pays, `funding`), then every event `generate` yields. Resolves once the generation has ended, stored
   * its final state and settled (a generation reports its own failures as
   * events; only `settle` can reject it).
   */
  start(
    begin: BeginSendResult,
    funding: Payer,
    sink: GenerationSink,
    generate: (signal: AbortSignal) => AsyncIterable<StreamEvent>,
    options: RunOptions = {},
  ): Promise<void> {
    const run: Run = {
      node: { ...begin.assistantNode },
      sinks: new Set(),
      controller: new AbortController(),
      finished: Promise.resolve(),
    };
    const { userNode, assistantNode, branch } = begin;
    this.runs.set(assistantNode.id, run);
    this.add(run, sink, { type: 'start', userNode, assistantNode, branch, funding });
    run.finished = this.pump(assistantNode.id, run, generate, options);
    return run.finished;
  }

  /** Adds `sink` to the running generation of `nodeId`, from a snapshot; false when none runs. */
  attach(nodeId: string, sink: GenerationSink): boolean {
    const run = this.runs.get(nodeId);
    if (!run) return false;
    this.add(run, sink, { type: 'snapshot', node: run.node });
    return true;
  }

  /** Stops writing to `sink`; false when it wasn't reading `nodeId` (any more). */
  detach(nodeId: string, sink: GenerationSink): boolean {
    return this.runs.get(nodeId)?.sinks.delete(sink) ?? false;
  }

  /** Aborts the generation of `nodeId` (it stores what it has); false when none runs. */
  cancel(nodeId: string): boolean {
    const run = this.runs.get(nodeId);
    run?.controller.abort();
    return run !== undefined;
  }

  /** Aborts the matching generations and resolves once each has stored its final state. */
  async stop(match: (node: ChatNode) => boolean = () => true): Promise<void> {
    const doomed = [...this.runs.values()].filter((run) => match(run.node));
    for (const run of doomed) run.controller.abort();
    await Promise.all(doomed.map((run) => run.finished));
  }

  private add(run: Run, sink: GenerationSink, first: StreamEvent): void {
    run.sinks.add(sink);
    this.deliver(run, sink, () => sink.write(first));
  }

  private async pump(
    nodeId: string,
    run: Run,
    generate: (signal: AbortSignal) => AsyncIterable<StreamEvent>,
    { settle }: RunOptions,
  ): Promise<void> {
    const { keepAliveMs } = this.options;
    const keepAlive = keepAliveMs
      ? setInterval(() => {
          for (const sink of run.sinks) if (sink.ping) this.deliver(run, sink, () => sink.ping?.());
        }, keepAliveMs)
      : null;
    try {
      for await (const event of generate(run.controller.signal)) {
        if (event.type === 'delta')
          run.node = { ...run.node, content: run.node.content + event.text };
        if ((event.type === 'done' || event.type === 'error') && event.node) run.node = event.node;
        for (const sink of run.sinks) this.deliver(run, sink, () => sink.write(event));
      }
    } finally {
      if (keepAlive) clearInterval(keepAlive);
      try {
        await settle?.();
      } finally {
        this.runs.delete(nodeId);
        for (const sink of run.sinks) this.deliver(run, sink, () => sink.close());
        run.sinks.clear();
      }
    }
  }

  /** Runs one write to `sink`, dropping the sink when it throws or rejects. */
  private deliver(run: Run, sink: GenerationSink, write: () => void | Promise<void>): void {
    const drop = () => void run.sinks.delete(sink);
    try {
      const written = write();
      if (written instanceof Promise) written.catch(drop);
    } catch {
      drop();
    }
  }
}

/**
 * What a reader that reconnects to a generation no longer running gets:
 * the stored node, then how it ended.
 */
export function replayEvents(node: ChatNode, branch: Branch | null): StreamEvent[] {
  const events: StreamEvent[] = [{ type: 'snapshot', node }];
  if (node.status === 'complete' && branch) events.push({ type: 'done', node, branch });
  else
    events.push({
      type: 'error',
      nodeId: node.id,
      message: node.error ?? 'Generation failed',
      node,
    });
  return events;
}
