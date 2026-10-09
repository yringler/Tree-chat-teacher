import { ConflictError, GoneError, NotFoundError } from '@tangent/core';
import type { ChatNode, StreamEvent } from '@tangent/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { notFound, onError, validateJson, validateQuery } from '../src/http/errors.js';
import { sseFrame, sseKeepAliveFrame, sseResponse } from '../src/http/sse.js';
import { getCached, purgeShare, putCached, shareCacheKey } from '../src/share/cache.js';
import { checkShareRateLimit } from '../src/share/rate-limit.js';

describe('sse', () => {
  it('formats frames as event + single-line JSON data', () => {
    const ev: StreamEvent = { type: 'delta', nodeId: 'n1', text: 'line1\nline2 "q"' };
    const frame = sseFrame(ev);
    expect(frame).toBe(`event: delta\ndata: ${JSON.stringify(ev)}\n\n`);
    expect(frame.split('\n')).toHaveLength(4);
    const data = frame.split('\n')[1]!.slice('data: '.length);
    expect(JSON.parse(data)).toEqual(ev);
  });

  it('formats error events with null node', () => {
    const ev: StreamEvent = { type: 'error', nodeId: null, message: 'x', node: null };
    expect(sseFrame(ev).startsWith('event: error\ndata: {')).toBe(true);
  });

  it('keepalive is a comment frame', () => {
    expect(sseKeepAliveFrame()).toBe(': keepalive\n\n');
    expect(sseKeepAliveFrame('a\nb')).toBe(': a b\n\n');
  });

  it('sseResponse sets streaming headers', async () => {
    const node = { id: 'n' } as ChatNode;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(sseFrame({ type: 'snapshot', node })));
        ctrl.close();
      },
    });
    const res = sseResponse(body);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');
    expect(await res.text()).toContain('event: snapshot\n');
  });
});

describe('error handling and validation', () => {
  const app = new Hono();
  app.onError(onError);
  app.notFound(notFound);
  app.get('/nf', () => {
    throw new NotFoundError('Tree');
  });
  app.get('/conflict', () => {
    throw new ConflictError('busy');
  });
  app.get('/gone', () => {
    throw new GoneError('revoked');
  });
  app.get('/zod', () => {
    z.object({ a: z.string() }).parse({ a: 1 });
    return new Response('unreachable');
  });
  app.get('/boom', () => {
    throw new Error('secret db detail');
  });
  app.get('/http', () => {
    throw new HTTPException(429, { message: 'slow down' });
  });
  // Route entries of their own, shaped like API_ROUTES' (the validators take one).
  const bodyRoute = {
    method: 'POST',
    path: '/json',
    body: z.object({ title: z.string().min(1), n: z.number().int().default(1) }),
    reply: { kind: 'empty' },
  } as const;
  const queryRoute = {
    method: 'GET',
    path: '/query',
    query: z.object({ flag: z.enum(['true', 'false']).transform((v) => v === 'true') }),
    reply: { kind: 'empty' },
  } as const;
  app.post('/json', validateJson(bodyRoute), (c) => {
    const body = c.req.valid('json');
    return c.json({ title: body.title, n: body.n });
  });
  app.get('/query', validateQuery(queryRoute), (c) => c.json(c.req.valid('query')));

  async function get(path: string, init?: RequestInit) {
    const res = await app.request(path, init);
    return {
      status: res.status,
      body: (await res.json()) as { error?: { code: string; message: string } },
    };
  }

  it('maps DomainErrors to their HTTP status', async () => {
    expect(await get('/nf')).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'Tree not found' } },
    });
    expect((await get('/conflict')).status).toBe(409);
    expect((await get('/gone')).body.error?.code).toBe('gone');
  });

  it('maps ZodError to 400 with a readable message', async () => {
    const r = await get('/zod');
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('bad_request');
    expect(r.body.error?.message).toMatch(/^a: /);
  });

  it('hides unknown errors behind a 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await get('/boom');
    expect(r).toEqual({
      status: 500,
      body: { error: { code: 'internal', message: 'Internal error' } },
    });
    expect(JSON.stringify(r.body)).not.toContain('secret');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('maps HTTPException status', async () => {
    expect(await get('/http')).toEqual({
      status: 429,
      body: { error: { code: 'rate_limited', message: 'slow down' } },
    });
  });

  it('404s unknown routes as ApiError', async () => {
    expect((await get('/missing')).body.error?.code).toBe('not_found');
  });

  it('validateJson parses, applies defaults, and rejects bad bodies', async () => {
    const json = { 'Content-Type': 'application/json' };
    const ok = await app.request('/json', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'x' }),
    });
    expect(await ok.json()).toEqual({ title: 'x', n: 1 });

    const invalid = await get('/json', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: '' }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error?.message).toContain('title');

    const malformed = await get('/json', { method: 'POST', headers: json, body: '{nope' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error?.code).toBe('bad_request');

    const noType = await get('/json', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
    expect(noType.status).toBe(400);
  });

  it('validateQuery parses and rejects', async () => {
    expect(await (await app.request('/query?flag=true')).json()).toEqual({ flag: true });
    expect((await get('/query?flag=maybe')).status).toBe(400);
  });
});

describe('share cache', () => {
  const ctx = {
    promises: [] as Promise<unknown>[],
    waitUntil(p: Promise<unknown>) {
      this.promises.push(p);
    },
  };

  it('builds versioned keys', () => {
    expect(shareCacheKey('abc_-', 3, 'html').url).toBe(
      'https://share-cache.internal/abc_-/v3/html',
    );
    expect(shareCacheKey('abc', 1, 'json').url).toBe('https://share-cache.internal/abc/v1/json');
  });

  it('put/get/purge work (or miss gracefully) without throwing', async () => {
    const key = shareCacheKey('tok-roundtrip', 1, 'json');
    const original = new Response('{"a":1}', { headers: { 'Content-Type': 'application/json' } });
    putCached(ctx, key, original, 60);
    // The caller's response is untouched and still readable.
    expect(original.headers.get('Cache-Control')).toBeNull();
    expect(await original.text()).toBe('{"a":1}');
    await Promise.all(ctx.promises);
    const hit = await getCached(key);
    if (hit) expect(await hit.text()).toBe('{"a":1}');
    await purgeShare('tok-roundtrip', [1, 2]);
    expect(await getCached(key)).toBeNull();
  });

  it('treats a missing Cache API as a miss', async () => {
    vi.stubGlobal('caches', undefined);
    try {
      const key = shareCacheKey('t', 1, 'html');
      expect(await getCached(key)).toBeNull();
      expect(() => putCached(ctx, key, new Response('x'), 60)).not.toThrow();
      await expect(purgeShare('t', [1])).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('swallows Cache API failures', async () => {
    const broken = {
      default: {
        match: () => Promise.reject(new Error('no cache')),
        put: () => Promise.reject(new Error('no cache')),
        delete: () => Promise.reject(new Error('no cache')),
      },
    };
    vi.stubGlobal('caches', broken);
    try {
      const key = shareCacheKey('t', 1, 'html');
      expect(await getCached(key)).toBeNull();
      const local: Promise<unknown>[] = [];
      putCached({ waitUntil: (p) => local.push(p) }, key, new Response('x'), 60);
      await Promise.all(local);
      await expect(purgeShare('t', [1])).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('share rate limit', () => {
  it('allows when the binding is missing', async () => {
    expect(await checkShareRateLimit({}, new Request('https://x/s/t'))).toBe(true);
  });

  it('keys by CF-Connecting-IP, falling back to anon', async () => {
    const keys: string[] = [];
    const limiter = {
      limit: ({ key }: { key: string }) => {
        keys.push(key);
        return Promise.resolve({ success: key !== '1.2.3.4' });
      },
    } as RateLimit;
    expect(
      await checkShareRateLimit(
        { SHARE_RATE_LIMITER: limiter },
        new Request('https://x', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      ),
    ).toBe(false);
    expect(
      await checkShareRateLimit({ SHARE_RATE_LIMITER: limiter }, new Request('https://x')),
    ).toBe(true);
    expect(keys).toEqual(['1.2.3.4', 'anon']);
  });

  it('allows when the limiter throws', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const limiter = { limit: () => Promise.reject(new Error('down')) } as RateLimit;
    expect(
      await checkShareRateLimit({ SHARE_RATE_LIMITER: limiter }, new Request('https://x')),
    ).toBe(true);
    spy.mockRestore();
  });
});
