import type { ReviewEvent, StreamEvent } from '@tangent/shared';

/** One SSE frame: `event: <type>\ndata: <json>\n\n`. JSON never contains raw newlines. */
export function sseFrame(event: StreamEvent | ReviewEvent): string {
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
