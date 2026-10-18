// The fixture sanitizer of the live suite's record mode, offline: whatever a recorded
// response carries, a key never reaches a committed fixture.
import { describe, expect, it } from 'vitest';
import { FIXTURE_MAX_BYTES, sanitizeRecording, type RecordedResponse } from './sanitize.js';

const KEY = `sk-or-v1-${'a1'.repeat(32)}`;

function recording(body: string, contentType = 'text/event-stream'): RecordedResponse {
  return {
    adapter: 'openrouter',
    scenario: 'basic',
    model: 'test/model',
    status: 200,
    contentType,
    body,
    expectation: { outcome: 'success' },
  };
}

const sse = (...chunks: unknown[]) =>
  [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join('');

function body(text: string): string {
  return (JSON.parse(text) as RecordedResponse).body;
}

describe('sanitizeRecording', () => {
  it('replaces ids with stable placeholders and empties thinking and page text', () => {
    const text = sanitizeRecording(
      recording(
        sse(
          {
            id: 'gen-123abc',
            created: 1760000000,
            choices: [{ delta: { content: 'Hi', reasoning: 'secret thoughts' } }],
          },
          {
            id: 'gen-123abc',
            choices: [
              {
                delta: {
                  reasoning_details: [{ type: 'reasoning.text', text: 'more thoughts' }],
                  annotations: [
                    {
                      type: 'url_citation',
                      url_citation: { url: 'https://example.org', content: 'page body' },
                    },
                  ],
                },
              },
            ],
          },
          { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'abc' } },
        ),
      ),
      [KEY],
    );
    const out = body(text);
    expect(out).toContain('"id":"gen-0001"');
    expect(out).not.toContain('123abc');
    expect(out).toContain('"created":0');
    expect(out).not.toContain('thoughts');
    expect(out).not.toContain('page body');
    expect(out).toContain('https://example.org');
    expect(out).toContain('"signature":"[redacted]"');
    expect(out).toContain('"content":"Hi"');
    expect(out).toContain('data: [DONE]');
  });

  it('refuses a recording that carries a key, wherever it is', () => {
    expect(() =>
      sanitizeRecording(recording(sse({ choices: [{ delta: { content: KEY } }] })), [KEY]),
    ).toThrow(/contains a key/);
    expect(() =>
      sanitizeRecording(
        recording(JSON.stringify({ error: { message: `bad ${KEY}` } }), 'json'),
        [],
      ),
    ).toThrow(/refusing/);
    expect(() =>
      sanitizeRecording(recording(sse({ note: 'Authorization: Bearer x' })), []),
    ).toThrow(/refusing/);
  });

  it('refuses a fixture over the size cap', () => {
    const big = sse({ choices: [{ delta: { content: 'x'.repeat(FIXTURE_MAX_BYTES) } }] });
    expect(() => sanitizeRecording(recording(big), [])).toThrow(/over the cap/);
  });
});
