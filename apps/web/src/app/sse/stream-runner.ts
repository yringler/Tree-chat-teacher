import type { StreamEvent } from '@tangent/shared';
import { readStreamEvents } from './sse-parser';

/**
 * Drives one generation stream with reconnects. Pure (injected I/O) so it can
 * be unit-tested without Angular or a DOM.
 *
 * - `open` starts the stream (POST send). When it rejects before any event
 *   (e.g. a 409 or 400), the error is rethrown to the caller.
 * - If the body ends or fails before a terminal `done`/`error`, the runner
 *   reconnects through `reconnect(assistantNodeId)` (GET /api/nodes/:id/stream,
 *   which replays a `snapshot` and continues) with exponential backoff.
 */
export interface StreamRunnerDeps {
  open: ((signal: AbortSignal) => Promise<Response>) | null;
  reconnect: (nodeId: string, signal: AbortSignal) => Promise<Response>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface StreamRunOptions {
  /** Assistant node to resume (required when `open` is null). */
  nodeId?: string;
  maxReconnects?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  /** Called before each reconnect attempt (1-based). */
  onReconnect?: (attempt: number) => void;
}

export type StreamOutcome =
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'lost'; message: string }
  | { kind: 'aborted' };

/** Errors carrying an HTTP status (ApiError) that should not be retried. */
function isPermanent(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('status' in err)) return false;
  const status = err.status;
  return (
    typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function runStream(
  deps: StreamRunnerDeps,
  onEvent: (event: StreamEvent) => void,
  options: StreamRunOptions = {},
): Promise<StreamOutcome> {
  const signal = options.signal ?? new AbortController().signal;
  const maxReconnects = options.maxReconnects ?? 4;
  const baseDelay = options.baseDelayMs ?? 500;
  const sleep = deps.sleep ?? defaultSleep;
  let nodeId: string | null = options.nodeId ?? null;
  let attempt = 0;
  let lastError = 'connection lost';

  /** Consumes one response; returns the outcome if terminal, else null (dropped). */
  const consume = async (response: Response): Promise<StreamOutcome | null> => {
    if (!response.body) return null;
    for await (const event of readStreamEvents(response.body)) {
      if (event.type === 'start') nodeId = event.assistantNode.id;
      if (event.type === 'snapshot') nodeId = event.node.id;
      attempt = 0;
      onEvent(event);
      if (event.type === 'done') return { kind: 'done' };
      if (event.type === 'error') return { kind: 'error', message: event.message };
    }
    return null;
  };

  if (deps.open) {
    const response = await deps.open(signal); // errors before the stream starts propagate
    try {
      const outcome = await consume(response);
      if (outcome) return outcome;
    } catch (err) {
      if (signal.aborted) return { kind: 'aborted' };
      lastError = message(err);
    }
  } else if (!nodeId) {
    throw new Error('runStream: either open or nodeId is required');
  }

  for (;;) {
    if (signal.aborted) return { kind: 'aborted' };
    if (!nodeId) return { kind: 'lost', message: `Stream ended before it started (${lastError})` };
    if (attempt >= maxReconnects) return { kind: 'lost', message: lastError };
    const delay = deps.open || attempt > 0 ? baseDelay * 2 ** attempt : 0;
    attempt++;
    options.onReconnect?.(attempt);
    if (delay > 0) await sleep(delay, signal);
    if (signal.aborted) return { kind: 'aborted' };
    try {
      const response = await deps.reconnect(nodeId, signal);
      const outcome = await consume(response);
      if (outcome) return outcome;
      lastError = 'connection lost';
    } catch (err) {
      if (signal.aborted) return { kind: 'aborted' };
      lastError = message(err);
      if (isPermanent(err)) return { kind: 'lost', message: lastError };
    }
  }
}
