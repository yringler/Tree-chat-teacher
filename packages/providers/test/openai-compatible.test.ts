import { describe, expect, it } from 'vitest';
import type { GenerateRequest, ProviderConfig, ProviderEvent } from '@tangent/shared';
import { createOpenAiCompatibleProvider } from '../src/openai-compatible.js';
import { collect, frame, jsonResponse, mockFetch, sseResponse, withTimeout } from './helpers.js';

const OPENAI: ProviderConfig = {
  id: 'openai',
  kind: 'openai-compatible',
  label: 'OpenAI',
  apiKeySecret: 'OPENAI_API_KEY',
  defaultModel: 'gpt-5',
  models: [{ id: 'gpt-5', label: 'GPT-5' }],
};

const OPENROUTER: ProviderConfig = {
  id: 'openrouter',
  kind: 'openai-compatible',
  label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKeySecret: 'OPENROUTER_API_KEY',
  defaultModel: 'anthropic/claude-sonnet-5.5',
  models: [{ id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5 (OpenRouter)' }],
};

const SECRETS = { OPENAI_API_KEY: 'sk-proj-openai-key-123456', OPENROUTER_API_KEY: 'sk-or-v1-abcdefabcdef' };

function req(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: 'gpt-5',
    system: 'Be brief.',
    messages: [{ role: 'user', content: 'Hi' }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) {
  return frame(null, {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-5',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
}

const OPENAI_STREAM = [
  chunk({ role: 'assistant', content: '' }, null, { usage: null }),
  chunk({ content: 'Hel' }, null, { usage: null }),
  chunk({ content: 'lo!' }, null, { usage: null }),
  chunk({}, 'stop', { usage: null }),
  frame(null, {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  }),
  'data: [DONE]\n\n',
];

const OPENROUTER_STREAM = [
  ': OPENROUTER PROCESSING\n\n',
  ': OPENROUTER PROCESSING\n\n',
  chunk({ role: 'assistant', content: 'Hi ' }),
  chunk({ role: 'assistant', content: 'there' }),
  chunk({ role: 'assistant', content: '' }, 'stop'),
  chunk({ role: 'assistant', content: '' }, null, {
    usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22, cost: 0.0001 },
  }),
  'data: [DONE]\n\n',
];

function setup(config: ProviderConfig, respond: Parameters<typeof mockFetch>[0], secrets: Record<string, string> = SECRETS) {
  const m = mockFetch(respond);
  return { provider: createOpenAiCompatibleProvider(config, { secrets, fetch: m.fetch }), calls: m.calls };
}

describe('openai-compatible provider', () => {
  it('parses the OpenAI stream with the final empty-choices usage chunk', async () => {
    const { provider, calls } = setup(OPENAI, () => sseResponse(OPENAI_STREAM).response);
    expect(await collect(provider.stream(req()))).toEqual<ProviderEvent[]>([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo!' },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
      { type: 'done', stopReason: 'stop' },
    ]);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers['authorization']).toBe(`Bearer ${SECRETS.OPENAI_API_KEY}`);
    expect(call.body).toEqual({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      // gpt-5 reasons: without a requested cap, its limit (REASONING_MAX_OUTPUT_TOKENS).
      max_completion_tokens: 32_000,
    });
    expect(call.body).not.toHaveProperty('temperature');
  });

  it('parses the OpenRouter stream (comments, one-choice usage chunk)', async () => {
    const { provider, calls } = setup(OPENROUTER, () => sseResponse(OPENROUTER_STREAM).response);
    expect(await collect(provider.stream(req({ model: 'anthropic/claude-sonnet-5.5', maxOutputTokens: 500 })))).toEqual<
      ProviderEvent[]
    >([
      { type: 'delta', text: 'Hi ' },
      { type: 'delta', text: 'there' },
      { type: 'usage', usage: { inputTokens: 20, outputTokens: 2 } },
      { type: 'billing', costUsd: 0.0001 },
      { type: 'done', stopReason: 'stop' },
    ]);
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]!.body['max_tokens']).toBe(500);
    expect(calls[0]!.body).not.toHaveProperty('max_completion_tokens');
  });

  it('respects an explicit maxTokensParam option', async () => {
    const { provider, calls } = setup(
      { ...OPENROUTER, options: { maxTokensParam: 'max_completion_tokens' } },
      () => sseResponse(OPENROUTER_STREAM).response,
    );
    await collect(provider.stream(req()));
    expect(calls[0]!.body).toHaveProperty('max_completion_tokens', 32_000);
    expect(calls[0]!.body).not.toHaveProperty('max_tokens');
  });

  it('maps an in-stream error object sent with HTTP 200 (OpenRouter)', async () => {
    const { provider } = setup(
      OPENROUTER,
      () =>
        sseResponse([
          chunk({ content: 'Partial' }),
          frame(null, {
            id: 'x',
            object: 'chat.completion.chunk',
            error: { code: 502, message: 'Provider disconnected unexpectedly' },
            choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
          }),
        ]).response,
    );
    expect(await collect(provider.stream(req()))).toEqual([
      { type: 'delta', text: 'Partial' },
      {
        type: 'error',
        error: { code: 'server', message: 'Provider disconnected unexpectedly', retryable: true, upstream: 'stream' },
      },
    ]);
  });

  it('maps a context-length in-stream error', async () => {
    const { provider } = setup(
      OPENROUTER,
      () =>
        sseResponse([
          frame(null, { error: { code: 400, message: "This endpoint's maximum context length is 200000 tokens" } }),
        ]).response,
    );
    const [ev] = await collect(provider.stream(req()));
    expect(ev).toMatchObject({ type: 'error', error: { code: 'context_length', retryable: false } });
  });

  it('ends with done at stream end when finish_reason was seen but [DONE] is missing', async () => {
    const { provider } = setup(OPENAI, () => sseResponse(OPENAI_STREAM.slice(0, -1)).response);
    const events = await collect(provider.stream(req()));
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('ends with done(null) at [DONE] without finish_reason', async () => {
    const { provider } = setup(OPENAI, () => sseResponse([chunk({ content: 'x' }), 'data: [DONE]\n\n']).response);
    expect(await collect(provider.stream(req()))).toEqual([
      { type: 'delta', text: 'x' },
      { type: 'done', stopReason: null },
    ]);
  });

  it('reports a truncated stream (no [DONE], no finish_reason) as a network error', async () => {
    const { provider } = setup(OPENAI, () => sseResponse(OPENAI_STREAM.slice(0, 2)).response);
    expect((await collect(provider.stream(req()))).at(-1)).toEqual({
      type: 'error',
      error: { code: 'network', message: 'stream ended unexpectedly', retryable: true },
    });
  });

  it('sends no Authorization header without apiKeySecret (local server)', async () => {
    const local: ProviderConfig = {
      id: 'local',
      kind: 'openai-compatible',
      label: 'Local',
      baseUrl: 'http://localhost:11434/v1/',
      defaultModel: 'llama',
      models: [{ id: 'llama', label: 'Llama' }],
    };
    const { provider, calls } = setup(local, () => sseResponse(OPENAI_STREAM).response, {});
    const events = await collect(provider.stream(req({ model: 'llama' })));
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0]!.headers).not.toHaveProperty('authorization');
    expect(calls[0]!.body).toHaveProperty('max_tokens');
  });

  it('yields a config error when the configured key secret is missing', async () => {
    const { provider, calls } = setup(OPENAI, () => sseResponse(OPENAI_STREAM).response, {});
    expect(await collect(provider.stream(req()))).toEqual([
      {
        type: 'error',
        error: { code: 'config', message: 'Missing secret OPENAI_API_KEY', retryable: false, upstream: 'not_sent' },
      },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('marks a connection failure as never sent upstream', async () => {
    const { provider } = setup(OPENAI, () => {
      throw new TypeError('connection refused');
    });
    expect(await collect(provider.stream(req()))).toEqual([
      {
        type: 'error',
        error: { code: 'network', message: 'Network error: connection refused', retryable: true, upstream: 'not_sent' },
      },
    ]);
  });

  it('folds the system prompt into the first user message when unsupported', async () => {
    const { provider, calls } = setup({ ...OPENAI, supportsSystemPrompt: false }, () => sseResponse(OPENAI_STREAM).response);
    expect(provider.capabilities('gpt-5').supportsSystemPrompt).toBe(false);
    await collect(provider.stream(req()));
    expect(calls[0]!.body['messages']).toEqual([{ role: 'user', content: 'Be brief.\n\nHi' }]);
  });

  it('omits the system message when system is null', async () => {
    const { provider, calls } = setup(OPENAI, () => sseResponse(OPENAI_STREAM).response);
    await collect(provider.stream(req({ system: null })));
    expect(calls[0]!.body['messages']).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it.each([
    [401, 'auth', false],
    [429, 'rate_limit', true],
    [503, 'overloaded', true],
    [502, 'server', true],
    [400, 'invalid_request', false],
  ] as const)('maps HTTP %i to %s using {error:{message}}', async (status, code, retryable) => {
    const { provider } = setup(OPENAI, () => jsonResponse(status, { error: { message: `oops ${status}`, type: 'x' } }));
    expect(await collect(provider.stream(req()))).toEqual([
      { type: 'error', error: { code, status, retryable, message: `oops ${status}`, upstream: 'rejected' } },
    ]);
  });

  it('maps context_length_exceeded 400s and redacts echoed keys', async () => {
    const { provider } = setup(OPENAI, () =>
      jsonResponse(400, {
        error: {
          message: "This model's maximum context length is 128000 tokens. However, you requested 130000 tokens.",
          code: 'context_length_exceeded',
        },
      }),
    );
    const [ev] = await collect(provider.stream(req()));
    expect(ev).toMatchObject({ type: 'error', error: { code: 'context_length', status: 400 } });

    const { provider: p2 } = setup(OPENAI, () =>
      jsonResponse(401, { error: { message: `Incorrect API key provided: ${SECRETS.OPENAI_API_KEY}` } }),
    );
    const [ev2] = await collect(p2.stream(req()));
    expect(JSON.stringify(ev2)).not.toContain(SECRETS.OPENAI_API_KEY);
  });

  it('aborts promptly mid-stream', async () => {
    const res = sseResponse([': OPENROUTER PROCESSING\n\n', chunk({ content: 'a' })], { hang: true });
    const { provider } = setup(OPENROUTER, () => res.response);
    const ac = new AbortController();
    const events: ProviderEvent[] = [];
    await withTimeout(
      (async () => {
        for await (const ev of provider.stream(req({ signal: ac.signal }))) {
          events.push(ev);
          setTimeout(() => ac.abort(), 5);
        }
      })(),
    );
    expect(events).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'error', error: { code: 'aborted', message: 'Request aborted', retryable: false } },
    ]);
    await withTimeout(res.body.cancelled);
  });

  it('aborts promptly before the response arrives', async () => {
    const { provider } = setup(OPENAI, () => new Promise<Response>(() => undefined));
    const ac = new AbortController();
    const run = collect(provider.stream(req({ signal: ac.signal })));
    setTimeout(() => ac.abort(), 5);
    expect(await withTimeout(run)).toEqual([
      { type: 'error', error: { code: 'aborted', message: 'Request aborted', retryable: false } },
    ]);
  });

  it('has no countTokens and reports capabilities defaults', () => {
    const { provider } = setup(OPENAI, () => jsonResponse(500, {}));
    expect(provider.countTokens).toBeUndefined();
    expect(provider.capabilities('gpt-4o')).toEqual({
      maxContextTokens: 128_000,
      maxOutputTokens: 8192,
      supportsSystemPrompt: true,
      supportsTokenCount: false,
      supportsWebSearch: false,
      reasoning: false,
    });
    // A reasoning model gets a larger limit unless the config names one.
    expect(provider.capabilities('gpt-5')).toMatchObject({ maxOutputTokens: 32_000, reasoning: true });
    const capped = setup({ ...OPENAI, maxOutputTokens: 4000 }, () => jsonResponse(500, {})).provider;
    expect(capped.capabilities('gpt-5')).toMatchObject({ maxOutputTokens: 4000, reasoning: true });
    const flagged = setup(
      { ...OPENAI, models: [{ id: 'my-model', label: 'Mine', reasoning: true }, { id: 'gpt-5', label: 'GPT-5', reasoning: false }] },
      () => jsonResponse(500, {}),
    ).provider;
    expect(flagged.capabilities('my-model')).toMatchObject({ maxOutputTokens: 32_000, reasoning: true });
    expect(flagged.capabilities('gpt-5')).toMatchObject({ maxOutputTokens: 8192, reasoning: false });
  });
});

describe('openai-compatible billing (OpenRouter)', () => {
  function orChunk(id: string, delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) {
    return frame(null, {
      id,
      provider: 'DeepSeek',
      model: 'deepseek/deepseek-v4-flash',
      object: 'chat.completion.chunk',
      created: 1_790_000_000,
      choices: [{ index: 0, delta, finish_reason: finish, native_finish_reason: finish, logprobs: null }],
      ...extra,
    });
  }

  const GEN = 'gen-1790000000-AbCdEfGh';
  // OpenRouter's real final chunk: one choice with an empty delta plus `usage` (cost in USD).
  const FINAL = orChunk(GEN, { role: 'assistant', content: '' }, null, {
    usage: {
      prompt_tokens: 42,
      completion_tokens: 7,
      total_tokens: 49,
      cost: 0.00000245,
      is_byok: false,
      prompt_tokens_details: { cached_tokens: 0 },
      cost_details: { upstream_inference_cost: null },
      completion_tokens_details: { reasoning_tokens: 3 },
    },
  });
  const STREAM = [
    ': OPENROUTER PROCESSING\n\n',
    orChunk(GEN, { role: 'assistant', content: 'Hi' }),
    orChunk(GEN, { role: 'assistant', content: '!' }),
    orChunk(GEN, { role: 'assistant', content: '' }, 'stop'),
    FINAL,
    'data: [DONE]\n\n',
  ];

  function withHeader(response: Response, id: string): Response {
    const headers = new Headers(response.headers);
    headers.set('x-generation-id', id);
    return new Response(response.body, { status: response.status, headers });
  }

  it('yields the x-generation-id header before any delta, then the cost from the final chunk', async () => {
    const { provider } = setup(OPENROUTER, () => withHeader(sseResponse(STREAM).response, 'gen-from-header'));
    expect(await collect(provider.stream(req()))).toEqual<ProviderEvent[]>([
      { type: 'billing', generationId: 'gen-from-header' },
      { type: 'delta', text: 'Hi' },
      { type: 'delta', text: '!' },
      { type: 'usage', usage: { inputTokens: 42, outputTokens: 7, cacheReadTokens: 0 } },
      { type: 'billing', costUsd: 0.00000245 },
      { type: 'done', stopReason: 'stop' },
    ]);
  });

  it('falls back to the first gen- chunk id (once) without the header', async () => {
    const { provider } = setup(OPENROUTER, () => sseResponse(STREAM).response);
    const events = await collect(provider.stream(req()));
    expect(events.slice(0, 2)).toEqual([
      { type: 'billing', generationId: GEN },
      { type: 'delta', text: 'Hi' },
    ]);
    expect(events.filter((e) => e.type === 'billing')).toEqual([
      { type: 'billing', generationId: GEN },
      { type: 'billing', costUsd: 0.00000245 },
    ]);
  });

  it('ignores chunk ids that are not gen- ids and a non-numeric cost', async () => {
    const { provider } = setup(
      OPENAI,
      () =>
        sseResponse([
          chunk({ content: 'x' }, 'stop'),
          frame(null, { id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: '0.1' } }),
          'data: [DONE]\n\n',
        ]).response,
    );
    const events = await collect(provider.stream(req()));
    expect(events.some((e) => e.type === 'billing')).toBe(false);
  });

  it('an aborted stream yields the generation id but no cost', async () => {
    const res = sseResponse([orChunk(GEN, { content: 'a' })], { hang: true });
    const { provider } = setup(OPENROUTER, () => res.response);
    const ac = new AbortController();
    const events: ProviderEvent[] = [];
    await withTimeout(
      (async () => {
        for await (const ev of provider.stream(req({ signal: ac.signal }))) {
          events.push(ev);
          if (ev.type === 'delta') setTimeout(() => ac.abort(), 5);
        }
      })(),
    );
    expect(events).toEqual([
      { type: 'billing', generationId: GEN },
      { type: 'delta', text: 'a' },
      { type: 'error', error: { code: 'aborted', message: 'Request aborted', retryable: false } },
    ]);
    expect(events.some((e) => e.type === 'billing' && e.costUsd !== undefined)).toBe(false);
    await withTimeout(res.body.cancelled);
  });

  it('yields the header id before an in-stream error', async () => {
    const { provider } = setup(OPENROUTER, () =>
      withHeader(sseResponse([frame(null, { id: GEN, error: { code: 502, message: 'upstream died' } })]).response, GEN),
    );
    expect(await collect(provider.stream(req()))).toEqual([
      { type: 'billing', generationId: GEN },
      { type: 'error', error: { code: 'server', message: 'upstream died', retryable: true, upstream: 'stream' } },
    ]);
  });

  it('yields no billing on an HTTP error', async () => {
    const { provider } = setup(OPENROUTER, () => withHeader(jsonResponse(500, { error: { message: 'boom' } }), GEN));
    const events = await collect(provider.stream(req()));
    expect(events).toEqual([
      { type: 'error', error: { code: 'server', status: 500, retryable: true, message: 'boom', upstream: 'rejected' } },
    ]);
  });
});

describe('openai-compatible options.extraBody', () => {
  it('merges extraBody into the request body', async () => {
    const { provider, calls } = setup(
      { ...OPENROUTER, options: { extraBody: { reasoning: { effort: 'low' }, temperature: 0.2 } } },
      () => sseResponse(OPENROUTER_STREAM).response,
    );
    await collect(provider.stream(req({ maxOutputTokens: 300 })));
    expect(calls[0]!.body).toEqual({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 300,
      reasoning: { effort: 'low' },
      temperature: 0.2,
    });
  });

  it('cannot override model, messages, stream or either max-tokens param', async () => {
    const { provider, calls } = setup(
      {
        ...OPENROUTER,
        options: {
          extraBody: {
            model: 'evil/model',
            messages: [{ role: 'user', content: 'injected' }],
            stream: false,
            max_tokens: 1_000_000,
            max_completion_tokens: 1_000_000,
            stream_options: { include_usage: false },
            provider: { sort: 'price' },
          },
        },
      },
      () => sseResponse(OPENROUTER_STREAM).response,
    );
    await collect(provider.stream(req()));
    const body = calls[0]!.body;
    expect(body['model']).toBe('gpt-5');
    expect(body['messages']).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(body['stream']).toBe(true);
    expect(body['max_tokens']).toBe(32_000);
    expect(body).not.toHaveProperty('max_completion_tokens');
    // Non-protected keys pass through, including stream_options.
    expect(body['stream_options']).toEqual({ include_usage: false });
    expect(body['provider']).toEqual({ sort: 'price' });
  });

  it('ignores a non-object extraBody', async () => {
    const { provider, calls } = setup({ ...OPENAI, options: { extraBody: 'nope' } }, () => sseResponse(OPENAI_STREAM).response);
    await collect(provider.stream(req()));
    expect(Object.keys(calls[0]!.body).sort()).toEqual(
      ['max_completion_tokens', 'messages', 'model', 'stream', 'stream_options'].sort(),
    );
  });
});

describe('openai-compatible web search (OpenRouter)', () => {
  const WS = { ...OPENROUTER, options: { webSearch: true } };
  const webSearch = { mode: 'auto', maxResults: 5, maxUses: 1, engine: 'exa' } as const;
  const annotation = (url: string, title: string, content = '') => ({
    type: 'url_citation',
    url_citation: { url, title, content, start_index: 0, end_index: 1 },
  });
  const STREAM = [
    chunk({ role: 'assistant', content: '', tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'web_search', arguments: '{}' } }] }),
    chunk({ content: 'Water boils at 100 °C [example.org](https://example.org/a).' }),
    chunk({ content: '', annotations: [annotation('https://example.org/a', 'A', 'x'.repeat(400)), annotation('javascript:alert(1)', 'bad')] }),
    chunk({ content: '', annotations: [annotation('https://example.org/a', 'A again'), annotation('https://b.example/', 'B')] }, 'stop'),
    chunk({}, null, { usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.0075, server_tool_use: { web_search_requests: 1 } } }),
    'data: [DONE]\n\n',
  ];

  it('reports the capability only with options.webSearch', () => {
    const on = setup(WS, () => jsonResponse(500, {})).provider;
    const off = setup(OPENROUTER, () => jsonResponse(500, {})).provider;
    expect(on.capabilities('x').supportsWebSearch).toBe(true);
    expect(off.capabilities('x').supportsWebSearch).toBe(false);
  });

  it('sends the server tool with auto tool_choice, and parses citations, activity and searches', async () => {
    const { provider, calls } = setup(WS, () => sseResponse(STREAM).response);
    const events = await collect(provider.stream(req({ webSearch })));
    expect(calls[0]!.body['tools']).toEqual([
      { type: 'openrouter:web_search', parameters: { engine: 'exa', max_results: 5, max_uses: 1 } },
    ]);
    expect(calls[0]!.body['tool_choice']).toBe('auto');
    expect(events[0]).toEqual({ type: 'activity', kind: 'web_search' });
    const cites = events.filter((e) => e.type === 'citations');
    expect(cites).toHaveLength(2);
    const last = cites.at(-1);
    expect(last?.type === 'citations' && last.citations.map((c) => c.url)).toEqual([
      'https://example.org/a',
      'https://b.example/',
    ]);
    const first = last?.type === 'citations' ? last.citations[0] : undefined;
    expect(first?.title).toBe('A');
    expect(first?.excerpt?.length).toBe(300);
    expect(events).toContainEqual({ type: 'billing', costUsd: 0.0075, webSearches: 1 });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('requires the tool for mode required', async () => {
    const { provider, calls } = setup(WS, () => sseResponse(OPENROUTER_STREAM).response);
    await collect(provider.stream(req({ webSearch: { ...webSearch, mode: 'required' } })));
    expect(calls[0]!.body['tool_choice']).toBe('required');
  });

  it('extraBody cannot override the tool while searching, but applies otherwise', async () => {
    const config = { ...WS, options: { webSearch: true, extraBody: { tools: [], tool_choice: 'none', plugins: [{ id: 'web' }] } } };
    const { provider, calls } = setup(config, () => sseResponse(OPENROUTER_STREAM).response);
    await collect(provider.stream(req({ webSearch })));
    expect(calls[0]!.body['tool_choice']).toBe('auto');
    expect(calls[0]!.body['plugins']).toBeUndefined();
    await collect(provider.stream(req()));
    expect(calls[1]!.body['tool_choice']).toBe('none');
  });

  it('ignores webSearch (and annotations) when the capability is off', async () => {
    const { provider, calls } = setup(OPENROUTER, () => sseResponse(STREAM).response);
    const events = await collect(provider.stream(req({ webSearch })));
    expect(calls[0]!.body['tools']).toBeUndefined();
    expect(events.some((e) => e.type === 'citations' || e.type === 'activity')).toBe(false);
  });
});

describe('openai-compatible prompt caching', () => {
  const BP = { type: 'ephemeral' };
  const HISTORY = {
    system: 'You are a patient tutor.',
    messages: [
      { role: 'user' as const, content: 'What is a derivative?' },
      { role: 'assistant' as const, content: 'The rate of change of a function.' },
      { role: 'user' as const, content: 'And an integral?' },
    ],
  };
  const MARKED = [
    {
      role: 'system',
      content: [{ type: 'text', text: 'You are a patient tutor.', cache_control: BP }],
    },
    { role: 'user', content: 'What is a derivative?' },
    { role: 'assistant', content: 'The rate of change of a function.' },
    { role: 'user', content: [{ type: 'text', text: 'And an integral?', cache_control: BP }] },
  ];
  const PLAIN = [
    { role: 'system', content: 'You are a patient tutor.' },
    { role: 'user', content: 'What is a derivative?' },
    { role: 'assistant', content: 'The rate of change of a function.' },
    { role: 'user', content: 'And an integral?' },
  ];

  async function sentMessages(config: ProviderConfig, overrides: Partial<GenerateRequest>) {
    const { provider, calls } = setup(config, () => sseResponse(OPENROUTER_STREAM).response);
    await collect(provider.stream(req({ ...HISTORY, ...overrides })));
    return calls[0]!.body['messages'];
  }

  it.each(['anthropic/claude-sonnet-5.5', '~anthropic/claude-sonnet-latest'])(
    'marks the system prompt and the latest message for %s on OpenRouter',
    async (model) => {
      expect(await sentMessages(OPENROUTER, { model })).toEqual(MARKED);
    },
  );

  it('marks through the AI Gateway OpenRouter route', async () => {
    const gateway = {
      ...OPENROUTER,
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw/openrouter',
    };
    expect(await sentMessages(gateway, { model: 'anthropic/claude-sonnet-5.5' })).toEqual(MARKED);
  });

  it.each(['deepseek/deepseek-v4-pro', 'openai/gpt-5', 'google/gemini-3-pro', 'x-ai/grok-4'])(
    'sends plain string content for %s (automatic caching)',
    async (model) => {
      expect(await sentMessages(OPENROUTER, { model })).toEqual(PLAIN);
    },
  );

  it('never marks on other endpoints, even for anthropic/ model ids', async () => {
    const other = { ...OPENAI, baseUrl: 'https://llm.example.com/v1' };
    expect(await sentMessages(other, { model: 'anthropic/claude-sonnet-5.5' })).toEqual(PLAIN);
    expect(await sentMessages(OPENAI, { model: 'gpt-5' })).toEqual(PLAIN);
  });

  it('options.promptCache false disables it; true enables it on any endpoint', async () => {
    const off = { ...OPENROUTER, options: { promptCache: false } };
    expect(await sentMessages(off, { model: 'anthropic/claude-sonnet-5.5' })).toEqual(PLAIN);
    const on = {
      ...OPENAI,
      baseUrl: 'https://proxy.example.com/v1',
      options: { promptCache: true },
    };
    expect(await sentMessages(on, { model: 'anthropic/claude-sonnet-5.5' })).toEqual(MARKED);
    expect(await sentMessages(on, { model: 'deepseek/deepseek-v4-pro' })).toEqual(PLAIN);
  });

  it('marks only the latest message without a system prompt', async () => {
    expect(
      await sentMessages(OPENROUTER, { model: 'anthropic/claude-sonnet-5.5', system: null }),
    ).toEqual(MARKED.slice(1));
  });

  it('keeps a breakpoint on a folded system prompt only when it is the latest message', async () => {
    const folded = { ...OPENROUTER, supportsSystemPrompt: false };
    expect(
      await sentMessages(folded, {
        model: 'anthropic/claude-sonnet-5.5',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'You are a patient tutor.\n\nHi', cache_control: BP }],
      },
    ]);
    expect(await sentMessages(folded, { model: 'anthropic/claude-sonnet-5.5' })).toEqual([
      { role: 'user', content: 'You are a patient tutor.\n\nWhat is a derivative?' },
      MARKED[2],
      MARKED[3],
    ]);
  });

  it('leaves an empty latest message as a string (an empty block cannot be marked)', async () => {
    const messages = [{ role: 'user' as const, content: '' }];
    expect(
      await sentMessages(OPENROUTER, { model: 'anthropic/claude-sonnet-5.5', messages }),
    ).toEqual([MARKED[0], { role: 'user', content: '' }]);
  });

  it('reports cache reads and writes from prompt_tokens_details', async () => {
    const stream = [
      chunk({ content: 'Hi' }),
      chunk({}, 'stop'),
      chunk({}, null, {
        usage: {
          prompt_tokens: 5000,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 3800, cache_write_tokens: 1150 },
          cost: 0.002,
        },
      }),
      'data: [DONE]\n\n',
    ];
    const { provider } = setup(OPENROUTER, () => sseResponse(stream).response);
    const events = await collect(provider.stream(req({ model: 'anthropic/claude-sonnet-5.5' })));
    expect(events).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 5000, outputTokens: 10, cacheReadTokens: 3800, cacheWriteTokens: 1150 },
    });
  });

  it("reports DeepSeek's prompt_cache_hit_tokens as cache reads", async () => {
    const stream = [
      chunk({}, 'stop'),
      chunk({}, null, {
        usage: {
          prompt_tokens: 900,
          completion_tokens: 4,
          prompt_cache_hit_tokens: 640,
          prompt_cache_miss_tokens: 260,
        },
      }),
      'data: [DONE]\n\n',
    ];
    const { provider } = setup(OPENAI, () => sseResponse(stream).response);
    expect(await collect(provider.stream(req()))).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 900, outputTokens: 4, cacheReadTokens: 640 },
    });
  });
});
