import { describe, expect, it } from 'vitest';
import type { GenerateRequest, ProviderConfig, ProviderEvent } from '@tangent/shared';
import { createAnthropicProvider } from '../src/anthropic.js';
import { collect, frame, jsonResponse, mockFetch, sseResponse, withTimeout } from './helpers.js';

const KEY = 'sk-ant-api03-SECRETSECRETSECRET';

const CONFIG: ProviderConfig = {
  id: 'anthropic',
  kind: 'anthropic',
  label: 'Anthropic',
  apiKeySecret: 'ANTHROPIC_API_KEY',
  defaultModel: 'claude-opus-5-5',
  models: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    {
      id: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      maxContextTokens: 100_000,
      maxOutputTokens: 1000,
    },
  ],
};

function req(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: 'claude-opus-5-5',
    system: 'Be brief.',
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Tell me a joke' },
    ],
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Recorded-style Anthropic stream. */
const RECORDED = [
  frame('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-opus-5-5',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 25,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    },
  }),
  frame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }),
  frame('ping', { type: 'ping' }),
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Why did' },
  }),
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'hmm' },
  }),
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: ' the chicken…' },
  }),
  frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  frame('some_future_event', { type: 'some_future_event' }),
  frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 15 },
  }),
  frame('message_stop', { type: 'message_stop' }),
];

function setup(
  respond: Parameters<typeof mockFetch>[0],
  secrets: Record<string, string | undefined> = {},
) {
  const m = mockFetch(respond);
  const provider = createAnthropicProvider(CONFIG, {
    secrets: { ANTHROPIC_API_KEY: KEY, ...secrets },
    fetch: m.fetch,
  });
  return { provider, calls: m.calls };
}

describe('anthropic provider', () => {
  it('maps a recorded stream to the exact event sequence', async () => {
    // Split the stream mid-frame to exercise chunk boundaries.
    const text = RECORDED.join('');
    const chunks = [text.slice(0, 50), text.slice(50, 333), text.slice(333, 700), text.slice(700)];
    const { provider } = setup(() => sseResponse(chunks).response);
    expect(await collect(provider.stream(req()))).toEqual<ProviderEvent[]>([
      {
        type: 'usage',
        usage: { inputTokens: 25, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      { type: 'delta', text: 'Why did' },
      { type: 'delta', text: ' the chicken…' },
      { type: 'usage', usage: { outputTokens: 15 } },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('sends the documented request shape', async () => {
    const { provider, calls } = setup(() => sseResponse(RECORDED).response);
    await collect(provider.stream(req({ maxOutputTokens: 1234 })));
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.init.method).toBe('POST');
    expect(call.headers['x-api-key']).toBe(KEY);
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 1234,
      system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Tell me a joke', cache_control: { type: 'ephemeral' } }],
        },
      ],
      stream: true,
    });
    expect(call.body).not.toHaveProperty('temperature');
    expect(call.init.signal).toBeDefined();
  });

  it('omits system when null and defaults max_tokens from the model capabilities', async () => {
    const { provider, calls } = setup(() => sseResponse(RECORDED).response);
    await collect(provider.stream(req({ system: null, model: 'claude-haiku-4-5' })));
    expect(calls[0]!.body).not.toHaveProperty('system');
    expect(calls[0]!.body['max_tokens']).toBe(1000);
  });

  it('reports capabilities from model, then config, then defaults', () => {
    const { provider } = setup(() => jsonResponse(500, {}));
    expect(provider.capabilities('claude-haiku-4-5')).toEqual({
      maxContextTokens: 100_000,
      maxOutputTokens: 1000,
      supportsSystemPrompt: true,
      supportsTokenCount: true,
      supportsWebSearch: false,
      reasoning: true,
    });
    // A reasoning model without a configured limit may write REASONING_MAX_OUTPUT_TOKENS.
    expect(provider.capabilities('claude-opus-5-5')).toMatchObject({
      maxContextTokens: 200_000,
      maxOutputTokens: 32_000,
      reasoning: true,
    });
    expect(provider.capabilities('claude-3-5-haiku')).toMatchObject({
      maxOutputTokens: 8192,
      reasoning: false,
    });
    const p2 = createAnthropicProvider({ ...CONFIG, maxOutputTokens: 64_000 }, { secrets: {} });
    expect(p2.capabilities('claude-opus-5-5').maxOutputTokens).toBe(64_000);
    expect(provider.defaultModel()).toBe('claude-opus-5-5');
    expect(provider.models().map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5']);
  });

  it('routes through AI Gateway with baseUrl and secret-valued headers', async () => {
    const m = mockFetch(() => sseResponse(RECORDED).response);
    const provider = createAnthropicProvider(
      {
        ...CONFIG,
        baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/',
        headers: { 'cf-aig-max-attempts': '3' },
        extraHeaderSecrets: { 'cf-aig-authorization': 'CF_AIG_TOKEN' },
      },
      { secrets: { ANTHROPIC_API_KEY: KEY, CF_AIG_TOKEN: 'Bearer gw-token' }, fetch: m.fetch },
    );
    const events = await collect(provider.stream(req()));
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    const call = m.calls[0]!;
    expect(call.url).toBe('https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages');
    expect(call.headers['cf-aig-authorization']).toBe('Bearer gw-token');
    expect(call.headers['cf-aig-max-attempts']).toBe('3');
    expect(call.headers['x-api-key']).toBe(KEY);
  });

  it('yields a config error when a header secret is missing', async () => {
    const m = mockFetch(() => sseResponse(RECORDED).response);
    const provider = createAnthropicProvider(
      { ...CONFIG, extraHeaderSecrets: { 'cf-aig-authorization': 'CF_AIG_TOKEN' } },
      { secrets: { ANTHROPIC_API_KEY: KEY }, fetch: m.fetch },
    );
    expect(await collect(provider.stream(req()))).toEqual([
      {
        type: 'error',
        error: { code: 'config', message: 'Missing secret CF_AIG_TOKEN', retryable: false },
      },
    ]);
    expect(m.calls).toHaveLength(0);
  });

  it('maps a mid-stream error event', async () => {
    const { provider } = setup(
      () =>
        sseResponse([
          RECORDED[0]!,
          RECORDED[3]!,
          frame('error', {
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded' },
          }),
        ]).response,
    );
    expect(await collect(provider.stream(req()))).toEqual([
      {
        type: 'usage',
        usage: { inputTokens: 25, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      { type: 'delta', text: 'Why did' },
      { type: 'error', error: { code: 'overloaded', message: 'Overloaded', retryable: true } },
    ]);
  });

  it('maps other in-stream error types', async () => {
    const { provider } = setup(
      () =>
        sseResponse([
          frame('error', {
            type: 'error',
            error: { type: 'api_error', message: 'Internal error' },
          }),
        ]).response,
    );
    expect(await collect(provider.stream(req()))).toEqual([
      { type: 'error', error: { code: 'server', message: 'Internal error', retryable: true } },
    ]);
  });

  it.each([
    [
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      'auth',
      false,
    ],
    [
      403,
      { type: 'error', error: { type: 'permission_error', message: 'no access' } },
      'auth',
      false,
    ],
    [
      429,
      {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Number of requests exceeded' },
      },
      'rate_limit',
      true,
    ],
    [
      529,
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      'overloaded',
      true,
    ],
    [503, { error: { message: 'unavailable' } }, 'overloaded', true],
    [
      500,
      { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
      'server',
      true,
    ],
    [
      400,
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'messages: field required' },
      },
      'invalid_request',
      false,
    ],
    [
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: 212345 tokens > 200000 maximum',
        },
      },
      'context_length',
      false,
    ],
    [422, { error: { message: 'unprocessable' } }, 'invalid_request', false],
  ] as const)('maps HTTP %i to %s', async (status, body, code, retryable) => {
    const { provider } = setup(() => jsonResponse(status, body));
    const events = await collect(provider.stream(req()));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'error',
      error: { code, status, retryable, message: (body.error as { message: string }).message },
    });
  });

  it('uses a fallback message for non-JSON error bodies and never leaks the key', async () => {
    const { provider } = setup(() => new Response(`bad key ${KEY}`, { status: 401 }));
    const [ev] = await collect(provider.stream(req()));
    expect(ev).toMatchObject({ type: 'error', error: { code: 'auth', status: 401 } });
    expect(JSON.stringify(ev)).not.toContain(KEY);
    expect(JSON.stringify(ev)).not.toContain('SECRETSECRET');
  });

  it('maps fetch TypeError to a retryable network error', async () => {
    const { provider } = setup(() => {
      throw new TypeError('fetch failed');
    });
    expect(await collect(provider.stream(req()))).toEqual([
      {
        type: 'error',
        error: { code: 'network', message: 'Network error: fetch failed', retryable: true },
      },
    ]);
  });

  it('reports a truncated stream as a network error', async () => {
    const { provider } = setup(() => sseResponse(RECORDED.slice(0, 4)).response);
    const events = await collect(provider.stream(req()));
    expect(events.at(-1)).toEqual({
      type: 'error',
      error: { code: 'network', message: 'stream ended unexpectedly', retryable: true },
    });
    expect(events.filter((e) => e.type === 'error' || e.type === 'done')).toHaveLength(1);
  });

  it('aborts promptly before the response arrives (fetch ignoring the signal)', async () => {
    const { provider } = setup(() => new Promise<Response>(() => undefined));
    const ac = new AbortController();
    const run = collect(provider.stream(req({ signal: ac.signal })));
    setTimeout(() => ac.abort(), 5);
    expect(await withTimeout(run)).toEqual([
      { type: 'error', error: { code: 'aborted', message: 'Request aborted', retryable: false } },
    ]);
  });

  it('yields aborted without fetching when already aborted', async () => {
    const { provider, calls } = setup(() => sseResponse(RECORDED).response);
    const ac = new AbortController();
    ac.abort();
    expect(await collect(provider.stream(req({ signal: ac.signal })))).toEqual([
      { type: 'error', error: { code: 'aborted', message: 'Request aborted', retryable: false } },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('aborts promptly mid-stream and cancels the body', async () => {
    const res = sseResponse(RECORDED.slice(0, 4), { hang: true });
    const { provider } = setup(() => res.response);
    const ac = new AbortController();
    const events: ProviderEvent[] = [];
    const run = (async () => {
      for await (const ev of provider.stream(req({ signal: ac.signal }))) {
        events.push(ev);
        if (ev.type === 'delta') setTimeout(() => ac.abort(), 5);
      }
    })();
    await withTimeout(run);
    expect(events).toEqual([
      {
        type: 'usage',
        usage: { inputTokens: 25, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      { type: 'delta', text: 'Why did' },
      { type: 'error', error: { code: 'aborted', message: 'Request aborted', retryable: false } },
    ]);
    await withTimeout(res.body.cancelled);
  });

  it('counts tokens via /v1/messages/count_tokens', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, { input_tokens: 42 }));
    expect(provider.countTokens).toBeDefined();
    const n = await provider.countTokens!({
      model: 'claude-opus-5-5',
      system: null,
      messages: req().messages,
    });
    expect(n).toBe(42);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    expect(calls[0]!.headers['x-api-key']).toBe(KEY);
    expect(calls[0]!.body).toEqual({ model: 'claude-opus-5-5', messages: req().messages });
  });

  it('countTokens rejects with a mapped error', async () => {
    const { provider } = setup(() =>
      jsonResponse(429, { error: { type: 'rate_limit_error', message: 'slow down' } }),
    );
    await expect(
      provider.countTokens!({ model: 'claude-opus-5-5', system: 'x', messages: req().messages }),
    ).rejects.toMatchObject({ error: { code: 'rate_limit', status: 429 } });
  });
});

describe('anthropic prompt caching', () => {
  const BP = { type: 'ephemeral' };

  it('puts breakpoints on the system prompt and the latest message only', async () => {
    const { provider, calls } = setup(() => sseResponse(RECORDED).response);
    await collect(provider.stream(req()));
    const body = calls[0]!.body;
    expect(body['system']).toEqual([{ type: 'text', text: 'Be brief.', cache_control: BP }]);
    const messages = body['messages'] as { content: unknown }[];
    expect(messages.map((m) => m.content)).toEqual([
      'Hi',
      'Hello!',
      [{ type: 'text', text: 'Tell me a joke', cache_control: BP }],
    ]);
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(2);
  });

  it('marks only the latest message without a system prompt', async () => {
    const { provider, calls } = setup(() => sseResponse(RECORDED).response);
    await collect(
      provider.stream(req({ system: null, messages: [{ role: 'user', content: 'Hi' }] })),
    );
    expect(calls[0]!.body).not.toHaveProperty('system');
    expect(calls[0]!.body['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hi', cache_control: BP }] },
    ]);
  });

  it('sends turnInstructions after the latest message breakpoint, as their own part', async () => {
    const { provider, calls } = setup(() => sseResponse(RECORDED).response);
    await collect(provider.stream(req({ turnInstructions: 'Search once.' })));
    const body = calls[0]!.body;
    expect(body['system']).toEqual([{ type: 'text', text: 'Be brief.', cache_control: BP }]);
    const messages = body['messages'] as { role: string; content: unknown }[];
    expect(messages.map((m) => m.content)).toEqual([
      'Hi',
      'Hello!',
      [
        { type: 'text', text: 'Tell me a joke', cache_control: BP },
        { type: 'text', text: 'Search once.' },
      ],
    ]);
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(2);
  });

  it('appends turnInstructions to the plain text with options.promptCache false', async () => {
    const m = mockFetch(() => sseResponse(RECORDED).response);
    const provider = createAnthropicProvider(
      { ...CONFIG, options: { promptCache: false } },
      { secrets: { ANTHROPIC_API_KEY: KEY }, fetch: m.fetch },
    );
    await collect(provider.stream(req({ turnInstructions: 'Search once.' })));
    expect((m.calls[0]!.body['messages'] as unknown[]).at(-1)).toEqual({
      role: 'user',
      content: 'Tell me a joke\n\nSearch once.',
    });
  });

  it('sends plain content with options.promptCache false', async () => {
    const m = mockFetch(() => sseResponse(RECORDED).response);
    const provider = createAnthropicProvider(
      { ...CONFIG, options: { promptCache: false } },
      { secrets: { ANTHROPIC_API_KEY: KEY }, fetch: m.fetch },
    );
    await collect(provider.stream(req()));
    expect(m.calls[0]!.body['system']).toBe('Be brief.');
    expect(JSON.stringify(m.calls[0]!.body)).not.toContain('cache_control');
  });

  it('counts tokens without breakpoints', async () => {
    const { provider, calls } = setup(() => jsonResponse(200, { input_tokens: 42 }));
    await provider.countTokens!({
      model: 'claude-opus-5-5',
      system: 'Be brief.',
      messages: req().messages,
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain('cache_control');
  });

  it('reports the input total and the cache reads and writes', async () => {
    const stream = [
      frame('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_02',
          usage: {
            input_tokens: 12,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 4000,
            output_tokens: 1,
          },
        },
      }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 4000,
          output_tokens: 50,
        },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ];
    const { provider } = setup(() => sseResponse(stream).response);
    const usage = { inputTokens: 4312, cacheReadTokens: 4000, cacheWriteTokens: 300 };
    expect(await collect(provider.stream(req()))).toEqual<ProviderEvent[]>([
      { type: 'usage', usage: { ...usage, outputTokens: 1 } },
      { type: 'usage', usage: { ...usage, outputTokens: 50 } },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });
});

describe('anthropic web search', () => {
  const WS: ProviderConfig = { ...CONFIG, options: { webSearch: true } };
  const webSearch = { mode: 'auto', maxResults: 5, maxUses: 1, engine: 'exa' } as const;
  const cite = (url: string, title: string, citedText = '') => ({
    type: 'content_block_delta',
    index: 2,
    delta: {
      type: 'citations_delta',
      citation: {
        type: 'web_search_result_location',
        url,
        title,
        encrypted_index: 'x',
        cited_text: citedText,
      },
    },
  });
  const STREAM = [
    frame('message_start', {
      type: 'message_start',
      message: { usage: { input_tokens: 900, output_tokens: 1 } },
    }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"query":"boiling point"}' },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: [
          {
            type: 'web_search_result',
            url: 'https://example.org/a',
            title: 'A',
            encrypted_content: 'e',
          },
        ],
      },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'text', text: '' },
    }),
    frame('content_block_delta', cite('https://example.org/a', 'A', 'x'.repeat(400))),
    frame('content_block_delta', cite('javascript:alert(1)', 'bad')),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: 'Water boils at 100 °C.' },
    }),
    frame('content_block_delta', cite('https://example.org/a', 'A again')),
    frame('content_block_delta', cite('https://b.example/', 'B')),
    frame('content_block_stop', { type: 'content_block_stop', index: 2 }),
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 40, server_tool_use: { web_search_requests: 1 } },
    }),
    frame('message_stop', { type: 'message_stop' }),
  ];

  function setupWs(config: ProviderConfig) {
    const m = mockFetch(() => sseResponse(STREAM).response);
    const provider = createAnthropicProvider(config, {
      secrets: { ANTHROPIC_API_KEY: KEY },
      fetch: m.fetch,
    });
    return { provider, calls: m.calls };
  }

  it('reports the capability only with options.webSearch', () => {
    expect(setupWs(WS).provider.capabilities('claude-opus-5-5').supportsWebSearch).toBe(true);
    expect(setupWs(CONFIG).provider.capabilities('claude-opus-5-5').supportsWebSearch).toBe(false);
  });

  it('sends the server tool and maps activity, citations and searches', async () => {
    const { provider, calls } = setupWs(WS);
    const events = await collect(provider.stream(req({ webSearch })));
    expect(calls[0]!.body['tools']).toEqual([
      { type: 'web_search_20250305', name: 'web_search', max_uses: 1 },
    ]);
    expect(calls[0]!.body).not.toHaveProperty('tool_choice');
    expect(events.filter((e) => e.type === 'activity')).toEqual([
      { type: 'activity', kind: 'web_search' },
    ]);
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
    expect(events).toContainEqual({ type: 'delta', text: 'Water boils at 100 °C.' });
    expect(events).toContainEqual({ type: 'billing', webSearches: 1 });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('leaves tool_choice on auto when a search is required', async () => {
    const { provider, calls } = setupWs(WS);
    await collect(provider.stream(req({ webSearch: { ...webSearch, mode: 'required' } })));
    expect(calls[0]!.body['tools']).toHaveLength(1);
    expect(calls[0]!.body).not.toHaveProperty('tool_choice');
  });

  it('ignores webSearch (and citations) when the capability is off', async () => {
    const { provider, calls } = setupWs(CONFIG);
    const events = await collect(provider.stream(req({ webSearch })));
    expect(calls[0]!.body).not.toHaveProperty('tools');
    expect(events.some((e) => e.type === 'citations' || e.type === 'activity')).toBe(false);
  });
});
