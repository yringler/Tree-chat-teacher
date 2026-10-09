import type { CandidateEvent, ReviewEvent, StreamEvent } from '@tangent/shared';

/** What the Worker and the tree's Durable Object stream. */
export type SseEvent = StreamEvent | ReviewEvent | CandidateEvent;

/** One SSE frame: `event: <type>\ndata: <json>\n\n`. JSON never contains raw newlines. */
export function sseFrame(event: SseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Comment frame; ignored by SSE parsers but keeps proxies/idle timers from closing the stream. */
export function sseKeepAliveFrame(comment = 'keepalive'): string {
  return `: ${comment.replace(/[\r\n]+/g, ' ')}\n\n`;
}

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
};

export function sseResponse(
  readable: ReadableStream<Uint8Array>,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(SSE_HEADERS)) headers.set(k, v);
  return new Response(readable, {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers,
  });
}

/** Keepalive of the streams served straight from the Worker (reviews, compare candidates). */
const KEEPALIVE_MS = 15_000;

/**
 * An SSE response of `events`, each written as the frame `map` makes of it,
 * with a keepalive comment every 15s. The pump runs in the request's
 * `waitUntil`, past the returned 200; a write the client no longer reads is
 * dropped, and stopping the upstream is the iterable's job (the request's
 * signal).
 */
export function sseFromAsyncIterable<T>(
  c: { executionCtx: Pick<ExecutionContext, 'waitUntil'> },
  events: AsyncIterable<T>,
  map: (event: T) => SseEvent | Promise<SseEvent>,
): Response {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const write = (frame: string) => writer.write(encoder.encode(frame)).catch(() => undefined);
  const pump = async () => {
    const keepalive = setInterval(() => void write(sseKeepAliveFrame()), KEEPALIVE_MS);
    try {
      for await (const event of events) await write(sseFrame(await map(event)));
    } finally {
      clearInterval(keepalive);
      await writer.close().catch(() => undefined);
    }
  };
  c.executionCtx.waitUntil(pump());
  return sseResponse(readable);
}
