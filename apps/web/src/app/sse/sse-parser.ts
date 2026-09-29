import type { StreamEvent } from '@tangent/shared';

/**
 * Pure `text/event-stream` parsing (WHATWG SSE rules, the subset we need).
 * No Angular, no DOM: runs in Node for tests.
 */

export interface SseFrame {
  /** `event:` field, or 'message' when absent. */
  event: string;
  /** `data:` lines joined with '\n'. */
  data: string;
  id: string | null;
}

/**
 * Incremental parser. Feed decoded text chunks with `push`; complete frames
 * (terminated by a blank line) are returned. A trailing incomplete frame is
 * discarded at end of stream, as the SSE spec requires.
 */
export class SseParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];
  private lastId: string | null = null;
  /** A chunk ended with '\r': a following '\n' belongs to the same line break. */
  private pendingCr = false;

  push(chunk: string): SseFrame[] {
    let text = chunk;
    if (this.pendingCr) {
      this.pendingCr = false;
      if (text.startsWith('\n')) text = text.slice(1);
    }
    this.buffer += text;
    const frames: SseFrame[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A lone '\r' at the very end may be the first half of '\r\n'.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) {
        const line = this.buffer.slice(0, match.index);
        this.buffer = '';
        this.pendingCr = true;
        const frame = this.processLine(line);
        if (frame) frames.push(frame);
        break;
      }
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const frame = this.processLine(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** End of stream: drops any unterminated frame. */
  end(): SseFrame[] {
    this.buffer = '';
    this.eventName = '';
    this.dataLines = [];
    this.pendingCr = false;
    return [];
  }

  private processLine(line: string): SseFrame | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    switch (field) {
      case 'event':
        this.eventName = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) this.lastId = value;
        break;
      default:
        // `retry` and unknown fields are ignored.
        break;
    }
    return null;
  }

  private dispatch(): SseFrame | null {
    if (this.dataLines.length === 0) {
      this.eventName = '';
      return null;
    }
    const frame: SseFrame = {
      event: this.eventName || 'message',
      data: this.dataLines.join('\n'),
      id: this.lastId,
    };
    this.eventName = '';
    this.dataLines = [];
    return frame;
  }
}

const STREAM_EVENT_TYPES: ReadonlySet<string> = new Set<StreamEvent['type']>([
  'start',
  'snapshot',
  'status',
  'delta',
  'usage',
  'done',
  'error',
]);

/**
 * Turns one SSE frame into a StreamEvent. The JSON payload carries its own
 * `type`, which wins over the `event:` field. Unknown or malformed frames
 * yield null (ignored by callers).
 */
export function parseStreamEvent(frame: SseFrame): StreamEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) return null;
  const type = value.type;
  if (typeof type !== 'string' || !STREAM_EVENT_TYPES.has(type)) return null;
  // Shape is trusted beyond the discriminant: the server is ours and typed by the same contract.
  return value as StreamEvent;
}

export function isTerminal(event: StreamEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}

/** Reads a fetch Response body as a sequence of StreamEvents. */
export async function* readStreamEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        const event = parseStreamEvent(frame);
        if (event) yield event;
      }
    }
    for (const frame of parser.push(decoder.decode())) {
      const event = parseStreamEvent(frame);
      if (event) yield event;
    }
    parser.end();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed or errored.
    }
    reader.releaseLock();
  }
}
