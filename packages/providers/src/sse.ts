import { abortable } from './internal.js';

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
 *
 * When `signal` aborts, the pending read is abandoned, the body is cancelled
 * and the generator throws an `AbortError` DOMException. Breaking out of the
 * iteration early also cancels the body.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  /** The previous chunk ended with "\r": a leading "\n" belongs to that line break. */
  let skipLeadingLf = false;
  let eventName = '';
  let dataLines: string[] = [];
  let finished = false;

  const processLine = (line: string): SseMessage | null => {
    if (line === '') {
      const msg: SseMessage | null =
        dataLines.length > 0 ? { event: eventName || 'message', data: dataLines.join('\n') } : null;
      eventName = '';
      dataLines = [];
      return msg;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // `id`, `retry` and unknown fields are ignored.
    return null;
  };

  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const { done, value } = await abortable(reader.read(), signal);
      let text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (skipLeadingLf && text.length > 0) {
        if (text.startsWith('\n')) text = text.slice(1);
        skipLeadingLf = false;
      }
      buffer += text;

      let start = 0;
      const out: SseMessage[] = [];
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer.charCodeAt(i);
        if (ch !== 10 && ch !== 13) continue;
        const msg = processLine(buffer.slice(start, i));
        if (msg) out.push(msg);
        if (ch === 13) {
          if (i + 1 < buffer.length) {
            if (buffer.charCodeAt(i + 1) === 10) i++;
          } else {
            skipLeadingLf = true;
          }
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);

      if (done) {
        finished = true;
        // Final line without a line terminator, then an implicit blank line.
        if (buffer !== '') {
          const msg = processLine(buffer);
          if (msg) out.push(msg);
          buffer = '';
        }
        const last = processLine('');
        if (last) out.push(last);
      }

      for (const msg of out) yield msg;
      if (done) return;
    }
  } finally {
    if (!finished) {
      reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
