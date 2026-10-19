import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderErrorCode } from '@tangent/shared';
import {
  codeForStatus,
  errorFromResponse,
  extractErrorInfo,
  looksLikeContextLength,
  networkError,
  parseRetryAfter,
  redact,
} from '../src/internal.js';
import { jsonResponse } from './helpers.js';

describe('codeForStatus', () => {
  const cases: [number, ProviderErrorCode][] = [
    [400, 'invalid_request'],
    [401, 'auth'],
    [402, 'invalid_request'],
    [403, 'auth'],
    [404, 'invalid_request'],
    [408, 'network'],
    [413, 'invalid_request'],
    [422, 'invalid_request'],
    [429, 'rate_limit'],
    [500, 'server'],
    [502, 'server'],
    [503, 'overloaded'],
    [504, 'server'],
    [529, 'overloaded'],
    [200, 'unknown'],
    [302, 'unknown'],
  ];
  it.each(cases)('%i → %s', (status, code) => {
    expect(codeForStatus(status)).toBe(code);
  });
});

describe('looksLikeContextLength', () => {
  it.each([
    "This model's maximum context length is 128000 tokens.",
    'prompt is too long: 210000 tokens > 200000 maximum',
    'Input is too long for requested model.',
    'Too many input tokens',
    'too many tokens',
    'context_length_exceeded',
    'The context window was exceeded',
    "This request exceeds the model's maximum",
    'Request exceeds the max allowed size',
  ])('recognises %j', (message) => {
    expect(looksLikeContextLength(message)).toBe(true);
  });

  it.each(['Rate limit exceeded', 'Invalid API key', 'max_tokens must be positive', ''])(
    'rejects %j',
    (message) => {
      expect(looksLikeContextLength(message)).toBe(false);
    },
  );

  it('trusts the context_length_exceeded code whatever the message says', () => {
    expect(looksLikeContextLength('Bad request', 'context_length_exceeded')).toBe(true);
    expect(looksLikeContextLength('Bad request', 'invalid_request_error')).toBe(false);
  });
});

describe('extractErrorInfo', () => {
  it.each<[string, unknown, ReturnType<typeof extractErrorInfo>]>([
    [
      'the {error:{message,type,code}} shape',
      { error: { message: 'boom', type: 'overloaded_error', code: 529 } },
      { message: 'boom', type: 'overloaded_error', code: 529 },
    ],
    ['a string error', { error: 'plain' }, { message: 'plain' }],
    ['a top-level message', { message: 'top' }, { message: 'top' }],
    ['a null code, dropped', { error: { message: 'm', code: null } }, { message: 'm' }],
    [
      'non-string message and type, dropped',
      { error: { message: 1, type: 2, code: 'x' } },
      { code: 'x' },
    ],
    ['an error object over a top-level message', { error: {}, message: 'top' }, {}],
    ['an array', [{ error: 'x' }], {}],
    ['null', null, {}],
    ['a string body', 'oops', {}],
  ])('reads %s', (_name, body, expected) => {
    expect(extractErrorInfo(body)).toEqual(expected);
  });
});

describe('errorFromResponse', () => {
  const read = (res: Response, secrets: readonly string[] = []) =>
    errorFromResponse(res, undefined, secrets);

  it('maps a 413 that names the context length to context_length', async () => {
    const error = await read(
      jsonResponse(413, { error: { message: 'prompt is too long: 300000 tokens' } }),
    );
    expect(error).toEqual({
      code: 'context_length',
      message: 'prompt is too long: 300000 tokens',
      status: 413,
      retryable: false,
    });
  });

  it('keeps a 413 that says nothing about context as invalid_request', async () => {
    const error = await read(jsonResponse(413, { error: { message: 'Payload too large' } }));
    expect(error.code).toBe('invalid_request');
  });

  it('maps a 400 by the context_length_exceeded code alone', async () => {
    const error = await read(
      jsonResponse(400, { error: { message: 'Bad request', code: 'context_length_exceeded' } }),
    );
    expect(error.code).toBe('context_length');
  });

  it('never turns a 5xx into context_length, whatever its message', async () => {
    const error = await read(jsonResponse(500, { error: { message: 'context length exceeded' } }));
    expect(error.code).toBe('server');
  });

  it('maps an overloaded_error type on a 500 to a retryable overloaded', async () => {
    const error = await read(
      jsonResponse(500, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
    );
    expect(error).toEqual({ code: 'overloaded', message: 'busy', status: 500, retryable: true });
  });

  it('passes on a non-JSON body as the message', async () => {
    const error = await read(new Response('  upstream exploded  ', { status: 502 }));
    expect(error).toEqual({
      code: 'server',
      message: 'upstream exploded',
      status: 502,
      retryable: true,
    });
  });

  it('falls back to the status line for an empty body', async () => {
    const error = await read(new Response('', { status: 503, statusText: 'Service Unavailable' }));
    expect(error.message).toBe('HTTP 503 Service Unavailable');
    expect(error.code).toBe('overloaded');
  });

  it('redacts the secrets and key-like strings an upstream echoes back', async () => {
    const error = await read(
      jsonResponse(401, {
        error: { message: 'Bad key sk-ant-api03-SECRETSECRET for my-own-secret' },
      }),
      ['my-own-secret'],
    );
    expect(error.message).toBe('Bad key sk-ant…[redacted] for [redacted]');
    expect(error.code).toBe('auth');
  });

  it('clips a long message to 500 characters', async () => {
    const error = await read(jsonResponse(400, { error: { message: 'x'.repeat(2000) } }));
    expect(Array.from(error.message)).toHaveLength(500);
    expect(error.message.endsWith('…')).toBe(true);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.UTC(2026, 9, 19, 12, 0, 0);

  it.each([
    ['delta-seconds', '7', 7000],
    ['zero', '0', 0],
    ['padded seconds', ' 30 ', 30_000],
    ['an HTTP-date 90 s ahead', 'Mon, 19 Oct 2026 12:01:30 GMT', 90_000],
    ['an HTTP-date in the past', 'Mon, 19 Oct 2026 11:59:00 GMT', 0],
    ['seconds over the cap', '86400', 3_600_000],
    ['an HTTP-date over the cap', 'Tue, 20 Oct 2026 12:00:00 GMT', 3_600_000],
  ])('reads %s', (_name, value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });

  it.each([
    ['no header', null],
    ['an empty value', ''],
    ['a negative number', '-5'],
    ['a fraction', '1.5'],
    ['words', 'soon'],
    ['seconds with a unit', '10s'],
  ])('ignores %s', (_name, value) => {
    expect(parseRetryAfter(value, now)).toBeUndefined();
  });
});

describe('errorFromResponse retry-after', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('carries a 429 retry-after in seconds as retryAfterMs', async () => {
    const error = await errorFromResponse(
      jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '7' }),
      undefined,
      [],
    );
    expect(error).toEqual({
      code: 'rate_limit',
      message: 'slow down',
      status: 429,
      retryable: true,
      retryAfterMs: 7000,
    });
  });

  it('reads an HTTP-date relative to now', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 19, 12, 0, 0));
    const error = await errorFromResponse(
      jsonResponse(
        503,
        { error: { message: 'busy' } },
        { 'retry-after': 'Mon, 19 Oct 2026 12:00:20 GMT' },
      ),
      undefined,
      [],
    );
    expect(error.retryAfterMs).toBe(20_000);
  });

  it('leaves retryAfterMs out for a malformed or missing header', async () => {
    const malformed = await errorFromResponse(
      jsonResponse(429, { error: { message: 'x' } }, { 'retry-after': 'later' }),
      undefined,
      [],
    );
    expect(malformed).not.toHaveProperty('retryAfterMs');
    const missing = await errorFromResponse(jsonResponse(429, { error: {} }), undefined, []);
    expect(missing).not.toHaveProperty('retryAfterMs');
  });
});

describe('redact', () => {
  it.each([
    ['sk-ant-api03-abcdefghijk', 'sk-ant…[redacted]'],
    ['sk-or-v1-0123456789abcdef', 'sk-or-…[redacted]'],
    ['sk-proj-AbCdEf_123-xyz', 'sk-pro…[redacted]'],
    ['sk-abcdefgh', 'sk-abc…[redacted]'],
  ])('shortens the key-like %s', (key, shown) => {
    expect(redact(`key ${key} rejected`, [])).toBe(`key ${shown} rejected`);
  });

  it('leaves a sk- prefix too short to be a key', () => {
    expect(redact('sk-abcd and task-list', [])).toBe('sk-abcd and task-list');
  });

  it('replaces every occurrence of each secret', () => {
    expect(redact('abcd1234 then abcd1234 and wxyz', ['abcd1234', 'wxyz'])).toBe(
      '[redacted] then [redacted] and [redacted]',
    );
  });

  it('skips secrets under 4 characters, which would redact ordinary text', () => {
    expect(redact('a cat sat', ['a', 'at', 'cat'])).toBe('a cat sat');
    expect(redact('a cat sat', ['', 'a cat'])).toBe('[redacted] sat');
  });
});

describe('networkError', () => {
  it('is retryable, prefixed, redacted and clipped', () => {
    const error = networkError(new TypeError(`fetch failed for k3y-value ${'y'.repeat(600)}`), [
      'k3y-value',
    ]);
    expect(error.code).toBe('network');
    expect(error.retryable).toBe(true);
    expect(error.message.startsWith('Network error: fetch failed for [redacted] ')).toBe(true);
    expect(Array.from(error.message)).toHaveLength(500);
    expect(error.upstream).toBeUndefined();
  });
});
