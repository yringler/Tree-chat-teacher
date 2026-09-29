/** One parsed Server-Sent Event. */
export interface SseMessage {
  /** `event:` field; defaults to "message". */
  event: string;
  /** `data:` lines joined with "\n". */
  data: string;
}

/**
 * Incremental SSE parser over a byte stream (WHATWG EventSource parsing rules):
 * handles \n, \r\n and \r line endings, chunk boundaries anywhere (including
 * inside multi-byte UTF-8 sequences), multi-line `data:`, `:` comment lines
 * (e.g. OpenRouter's ": OPENROUTER PROCESSING"), and a final event without a
 * trailing blank line. Events with no data lines are skipped.
 */
// eslint-disable-next-line require-yield -- stub, replaced by implementation
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage> {
  void body;
  void signal;
  throw new Error('not implemented');
}
