import { describe, expect, it } from 'vitest';
import { parseSse, type SseMessage } from '../src/sse.js';
import { byteStream, withTimeout } from './helpers.js';

async function parseAll(chunks: readonly (string | Uint8Array)[]): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const m of parseSse(byteStream(chunks).stream)) out.push(m);
  return out;
}

const enc = new TextEncoder();

const SAMPLE =
  ': comment line\r\n' +
  'event: message_start\n' +
  'data: {"type":"message_start","text":"héllo 🌍 世界"}\n' +
  '\n' +
  'data: line one\r\n' +
  'data:line two\r\n' +
  'data:  two spaces\r\n' +
  '\r\n' +
  'event: ping\r' +
  'data: {}\r' +
  '\r' +
  'id: 7\n' +
  'retry: 1000\n' +
  '\n' +
  'event: final\n' +
  'data: last — no trailing blank line';

const SAMPLE_EXPECTED: SseMessage[] = [
  { event: 'message_start', data: '{"type":"message_start","text":"héllo 🌍 世界"}' },
  { event: 'message', data: 'line one\nline two\n two spaces' },
  { event: 'ping', data: '{}' },
  { event: 'final', data: 'last — no trailing blank line' },
];

describe('parseSse', () => {
  it('parses a sample stream in one chunk', async () => {
    expect(await parseAll([SAMPLE])).toEqual(SAMPLE_EXPECTED);
  });

  it('gives the same result when split at every byte offset', async () => {
    const bytes = enc.encode(SAMPLE);
    for (let i = 0; i <= bytes.length; i++) {
      const result = await parseAll([bytes.slice(0, i), bytes.slice(i)]);
      expect(result, `split at ${i}`).toEqual(SAMPLE_EXPECTED);
    }
  });

  it('gives the same result when fed one byte at a time', async () => {
    const bytes = enc.encode(SAMPLE);
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    expect(await parseAll(chunks)).toEqual(SAMPLE_EXPECTED);
  });

  it('handles CRLF split across chunks without producing an extra blank line', async () => {
    expect(await parseAll(['data: a\r', '\ndata: b\r', '\n\r', '\n'])).toEqual([{ event: 'message', data: 'a\nb' }]);
  });

  it('handles bare CR line endings', async () => {
    expect(await parseAll(['data: a\r\rdata: b\r\r'])).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
  });

  it('ignores comment lines (OpenRouter keep-alives)', async () => {
    expect(await parseAll([': OPENROUTER PROCESSING\n\n', ': x\ndata: 1\n\n'])).toEqual([
      { event: 'message', data: '1' },
    ]);
  });

  it('joins multi-line data and keeps empty data lines', async () => {
    expect(await parseAll(['data: a\ndata:\ndata: c\n\n'])).toEqual([{ event: 'message', data: 'a\n\nc' }]);
  });

  it('strips exactly one leading space from values', async () => {
    expect(await parseAll(['event:  x\ndata:   y\n\n'])).toEqual([{ event: ' x', data: '  y' }]);
  });

  it('decodes multi-byte UTF-8 split inside a code point', async () => {
    const bytes = enc.encode('data: 🌍é\n\n');
    // '🌍' starts at byte 6 and is 4 bytes long; split in its middle.
    expect(await parseAll([bytes.slice(0, 8), bytes.slice(8, 11), bytes.slice(11)])).toEqual([
      { event: 'message', data: '🌍é' },
    ]);
  });

  it('dispatches a final event without trailing newline', async () => {
    expect(await parseAll(['data: x'])).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('skips events without data and resets the event name', async () => {
    expect(await parseAll(['event: foo\n\ndata: bar\n\nevent: baz\n'])).toEqual([{ event: 'message', data: 'bar' }]);
  });

  it('treats a field with no colon as an empty value', async () => {
    expect(await parseAll(['data\ndata\n\n'])).toEqual([{ event: 'message', data: '\n' }]);
  });

  it('stops promptly on abort while a read is pending, and cancels the body', async () => {
    const body = byteStream(['data: one\n\n'], { hang: true });
    const ac = new AbortController();
    const seen: string[] = [];
    const run = (async () => {
      for await (const m of parseSse(body.stream, ac.signal)) {
        seen.push(m.data);
        setTimeout(() => ac.abort(), 5);
      }
    })();
    await expect(withTimeout(run)).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual(['one']);
    await withTimeout(body.cancelled);
  });

  it('throws immediately when the signal is already aborted', async () => {
    const body = byteStream(['data: one\n\n']);
    const ac = new AbortController();
    ac.abort();
    const it = parseSse(body.stream, ac.signal);
    await expect(it.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(body.isCancelled()).toBe(true);
  });

  it('cancels the body when the consumer stops early', async () => {
    const body = byteStream(['data: 1\n\ndata: 2\n\n'], { hang: true });
    for await (const m of parseSse(body.stream)) {
      expect(m.data).toBe('1');
      break;
    }
    await withTimeout(body.cancelled);
  });
});
