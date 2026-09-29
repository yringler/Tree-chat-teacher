import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@tangent/shared';
import { parseStreamEvent, readStreamEvents, SseParser, type SseFrame } from './sse-parser';

function feed(chunks: string[]): SseFrame[] {
  const parser = new SseParser();
  const frames: SseFrame[] = [];
  for (const c of chunks) frames.push(...parser.push(c));
  frames.push(...parser.end());
  return frames;
}

function frame(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe('SseParser', () => {
  it('parses a single frame', () => {
    expect(feed(['event: delta\ndata: {"a":1}\n\n'])).toEqual([
      { event: 'delta', data: '{"a":1}', id: null },
    ]);
  });

  it('handles frames split at arbitrary points', () => {
    const text = 'event: a\ndata: one\n\nevent: b\ndata: two\n\n';
    for (let i = 1; i < text.length; i++) {
      const frames = feed([text.slice(0, i), text.slice(i)]);
      expect(frames.map((f) => [f.event, f.data])).toEqual([
        ['a', 'one'],
        ['b', 'two'],
      ]);
    }
  });

  it('supports CRLF and CR line endings, including CRLF split across chunks', () => {
    expect(feed(['data: x\r\n\r\n', 'data: y\r\r'])).toEqual([
      { event: 'message', data: 'x', id: null },
      { event: 'message', data: 'y', id: null },
    ]);
    expect(feed(['data: x\r', '\n\r', '\n'])).toEqual([{ event: 'message', data: 'x', id: null }]);
  });

  it('joins multiple data lines, ignores comments and unknown fields', () => {
    expect(feed([': keep-alive\n', 'retry: 10\nfoo: bar\ndata: a\ndata:b\nid: 7\n\n'])).toEqual([
      { event: 'message', data: 'a\nb', id: '7' },
    ]);
  });

  it('skips frames without data and drops an unterminated trailing frame', () => {
    expect(feed(['event: ping\n\n', 'data: complete\n\n', 'data: partial'])).toEqual([
      { event: 'message', data: 'complete', id: null },
    ]);
  });
});

describe('parseStreamEvent', () => {
  it('accepts known event types', () => {
    const ev: StreamEvent = { type: 'delta', nodeId: 'n1', text: 'hi' };
    expect(parseStreamEvent({ event: 'delta', data: JSON.stringify(ev), id: null })).toEqual(ev);
  });

  it('rejects malformed or unknown payloads', () => {
    expect(parseStreamEvent({ event: 'delta', data: '{not json', id: null })).toBeNull();
    expect(parseStreamEvent({ event: 'x', data: '{"type":"nope"}', id: null })).toBeNull();
    expect(parseStreamEvent({ event: 'x', data: '42', id: null })).toBeNull();
    expect(parseStreamEvent({ event: 'x', data: 'null', id: null })).toBeNull();
  });
});

describe('readStreamEvents', () => {
  it('decodes a byte stream into events, across chunk and UTF-8 boundaries', async () => {
    const events: StreamEvent[] = [
      { type: 'status', message: 'summarizing…' },
      { type: 'delta', nodeId: 'a', text: 'héllo 🌳' },
      { type: 'usage', nodeId: 'a', usage: { outputTokens: 3 } },
    ];
    const text = events.map(frame).join('');
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 5) controller.enqueue(bytes.slice(i, i + 5));
        controller.close();
      },
    });
    const out: StreamEvent[] = [];
    for await (const e of readStreamEvents(body)) out.push(e);
    expect(out).toEqual(events);
  });

  it('ignores garbage frames', async () => {
    const out: StreamEvent[] = [];
    for await (const e of readStreamEvents(
      bodyOf(['data: nope\n\n', frame({ type: 'status', message: 'ok' })]),
    )) {
      out.push(e);
    }
    expect(out).toEqual([{ type: 'status', message: 'ok' }]);
  });
});
