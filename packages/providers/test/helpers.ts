import type { ProviderEvent } from '@tangent/shared';

const enc = new TextEncoder();

export interface TestStream {
  stream: ReadableStream<Uint8Array>;
  /** Resolves when the consumer cancels the stream. */
  cancelled: Promise<unknown>;
  isCancelled: () => boolean;
}

/**
 * A byte stream delivering `chunks` one per pull. With `hang: true` it never
 * closes after the last chunk (a pending read stays pending forever).
 */
export function byteStream(
  chunks: readonly (string | Uint8Array)[],
  opts: { hang?: boolean } = {},
): TestStream {
  let i = 0;
  let cancelledFlag = false;
  let resolveCancelled: (reason: unknown) => void = () => undefined;
  const cancelled = new Promise<unknown>((r) => (resolveCancelled = r));
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const c = chunks[i++];
        if (c !== undefined) {
          controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
          return;
        }
        if (opts.hang) return new Promise<void>(() => undefined);
        controller.close();
        return;
      },
      cancel(reason) {
        cancelledFlag = true;
        resolveCancelled(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, cancelled, isCancelled: () => cancelledFlag };
}

export function sseResponse(
  chunks: readonly (string | Uint8Array)[],
  opts: { hang?: boolean } = {},
): {
  response: Response;
  body: TestStream;
} {
  const body = byteStream(chunks, opts);
  return {
    response: new Response(body.stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    body,
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface RecordedCall {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch mock that records calls and answers with `respond`. */
export function mockFetch(respond: (call: RecordedCall) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const i = init ?? {};
    const headers: Record<string, string> = {};
    new Headers(i.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof i.body === 'string' ? (JSON.parse(i.body) as Record<string, unknown>) : {};
    const call: RecordedCall = { url: String(input), init: i, headers, body };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

export async function collect(iter: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

/** Builds an SSE frame. */
export function frame(event: string | null, data: unknown): string {
  const d = typeof data === 'string' ? data : JSON.stringify(data);
  return `${event ? `event: ${event}\n` : ''}data: ${d}\n\n`;
}

export function withTimeout<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}
