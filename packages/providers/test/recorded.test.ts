// Responses the live contract suite recorded from real endpoints
// (apps/worker/test/live, record mode), replayed offline through the real adapters,
// whole and in 7-byte chunks, against the contract they were recorded under.
import type { LlmProvider, ProviderConfig } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/anthropic.js';
import { createOpenAiCompatibleProvider } from '../src/openai-compatible.js';
import { checkContract, foldStream, type ContractExpectation } from './contract.js';
import { collect, mockFetch } from './helpers.js';

interface Fixture {
  adapter: 'openrouter' | 'anthropic' | 'openai';
  scenario: string;
  model: string;
  expectation: ContractExpectation;
  status: number;
  contentType: string;
  body: string;
}

const FIXTURES = import.meta.glob<Fixture>('./fixtures/live/**/*.json', {
  eager: true,
  import: 'default',
});

const KEY = 'sk-replay-key';

function provider(f: Fixture, fetch: typeof globalThis.fetch): LlmProvider {
  const config: ProviderConfig = {
    id: f.adapter,
    kind: f.adapter === 'anthropic' ? 'anthropic' : 'openai-compatible',
    label: f.adapter,
    apiKeySecret: 'KEY',
    models: [{ id: f.model, label: f.model }],
    defaultModel: f.model,
    options: { webSearch: f.adapter !== 'openai' },
    ...(f.adapter === 'openrouter' ? { baseUrl: 'https://openrouter.ai/api/v1' } : {}),
  };
  const env = { secrets: { KEY }, fetch };
  return f.adapter === 'anthropic'
    ? createAnthropicProvider(config, env)
    : createOpenAiCompatibleProvider(config, env);
}

/** `text` as a body that arrives `size` bytes at a time (whole when `size` is 0). */
function body(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      const end = size === 0 ? bytes.length : Math.min(at + size, bytes.length);
      controller.enqueue(bytes.slice(at, end));
      at = end;
    },
  });
}

async function replay(f: Fixture, chunk: number) {
  const { fetch } = mockFetch(
    () =>
      new Response(body(f.body, chunk), {
        status: f.status,
        headers: { 'content-type': f.contentType },
      }),
  );
  const search = f.expectation.search;
  const events = await collect(
    provider(f, fetch).stream({
      model: f.model,
      system: 'You are a concise tutor.',
      messages: [{ role: 'user', content: 'Hello' }],
      maxOutputTokens: 16,
      signal: new AbortController().signal,
      ...(search
        ? {
            webSearch: {
              mode: f.adapter === 'anthropic' ? ('auto' as const) : ('required' as const),
              maxUses: search.maxUses,
            },
          }
        : {}),
    }),
  );
  return checkContract(foldStream(events), f.expectation, [KEY]);
}

const cases = Object.entries(FIXTURES).map(([path, f]) => ({ path, f }));

describe('recorded live responses', () => {
  it('has fixtures to replay', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)('$path replays whole and in 7-byte chunks', async ({ f }) => {
    for (const chunk of [0, 7]) expect(await replay(f, chunk)).toMatchObject({ failures: [] });
  });
});
