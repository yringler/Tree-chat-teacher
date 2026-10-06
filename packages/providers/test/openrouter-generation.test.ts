import { describe, expect, it } from 'vitest';
import { fetchOpenRouterGeneration } from '../src/openrouter-generation.js';
import { jsonResponse, mockFetch } from './helpers.js';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const ID = 'gen-1790000000-AbCdEfGh';

async function thrown(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error(`threw a non-Error: ${String(e)}`, { cause: e });
  }
  throw new Error('expected a rejection');
}

describe('fetchOpenRouterGeneration', () => {
  it('GETs the generation with a Bearer key and parses the cost (200)', async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse(200, {
        data: {
          id: ID,
          total_cost: 0.00123,
          native_tokens_prompt: 1200,
          native_tokens_completion: 340,
          native_tokens_reasoning: 100,
          cancelled: false,
          finish_reason: 'stop',
          model: 'deepseek/deepseek-v4-pro',
          is_byok: false,
          num_search_results: 5,
        },
      }),
    );
    expect(await fetchOpenRouterGeneration(ID, KEY, fetch)).toEqual({
      costUsd: 0.00123,
      inputTokens: 1200,
      outputTokens: 340,
      cancelled: false,
      numSearchResults: 5,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://openrouter.ai/api/v1/generation?id=${ID}`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
  });

  it('reports a cancelled generation and missing token counts as null', async () => {
    const { fetch } = mockFetch(() => jsonResponse(200, { data: { total_cost: 0, cancelled: true, native_tokens_prompt: null } }));
    expect(await fetchOpenRouterGeneration(ID, KEY, fetch)).toEqual({
      costUsd: 0,
      inputTokens: null,
      outputTokens: null,
      cancelled: true,
      numSearchResults: null,
    });
  });

  it('URL-encodes the id', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(404, { error: { message: 'not found' } }));
    await fetchOpenRouterGeneration('gen-a&b=c', KEY, fetch);
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/generation?id=gen-a%26b%3Dc');
  });

  it('resolves null on 404 (not yet available)', async () => {
    const { fetch } = mockFetch(() => jsonResponse(404, { error: { message: `Generation ${ID} not found`, code: 404 } }));
    expect(await fetchOpenRouterGeneration(ID, KEY, fetch)).toBeNull();
  });

  it('throws on 500 with a redacted message', async () => {
    const { fetch } = mockFetch(() => jsonResponse(500, { error: { message: `Internal error for key ${KEY}` } }));
    const err = await thrown(fetchOpenRouterGeneration(ID, KEY, fetch));
    expect(err.message).toMatch(/HTTP 500/);
    expect(err.message).not.toContain(KEY);
  });

  it('throws on 401 without leaking the key', async () => {
    const { fetch } = mockFetch(() => jsonResponse(401, `Invalid key ${KEY}`));
    const err = await thrown(fetchOpenRouterGeneration(ID, KEY, fetch));
    expect(err.message).toMatch(/HTTP 401/);
    expect(err.message).not.toContain(KEY);
  });

  it('throws on a network failure without leaking the key', async () => {
    const failing = (async () => {
      throw new TypeError(`fetch failed (Authorization: Bearer ${KEY})`);
    }) as typeof fetch;
    const err = await thrown(fetchOpenRouterGeneration(ID, KEY, failing));
    expect(err.message).toMatch(/lookup failed/);
    expect(err.message).not.toContain(KEY);
  });

  it('throws on a body without data.total_cost', async () => {
    const { fetch } = mockFetch(() => jsonResponse(200, { data: { cancelled: false } }));
    const err = await thrown(fetchOpenRouterGeneration(ID, KEY, fetch));
    expect(err.message).toMatch(/total_cost/);
    const { fetch: f2 } = mockFetch(() => jsonResponse(200, 'not json'));
    expect((await thrown(fetchOpenRouterGeneration(ID, KEY, f2))).message).toMatch(/not JSON/);
  });

  it('redacts a short custom key echoed back by the server', async () => {
    const custom = 'my-secret-key-xyz';
    const { fetch } = mockFetch(() => jsonResponse(502, `bad gateway (${custom})`));
    const err = await thrown(fetchOpenRouterGeneration(ID, custom, fetch));
    expect(err.message).not.toContain(custom);
  });
});
