import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppBindings, AppEnv } from '../src/env.js';
// @ts-expect-error -- `?raw` is a Vite import; the worker tsconfig has no vite/client types.
import headersText from '../../web/public/_headers?raw';
import {
  canvasAppRoutes,
  LEARN_APP_CSP,
  LEARN_COMMON_HEADERS,
  LEARN_LOGIN_CSP,
  learnAppRoutes,
} from '../src/http/learn-app.js';

const ORIGIN = 'https://tangent.example.com';
const SIMPLE_INDEX = '<!doctype html><title>simple</title>';
const CANVAS_INDEX = '<!doctype html><title>canvas</title>';
const POWER_INDEX = '<!doctype html><title>power</title>';

/**
 * Stand-in for the Workers Static Assets binding: an in-memory site laid out
 * like apps/worker/site after `pnpm build`, with the same routing rules the
 * real binding applies (`/learn/` serves `learn/index.html`; anything missing
 * gets the root index.html, as `not_found_handling: single-page-application`
 * does). Records every request so tests can see what reached ASSETS.
 */
function fakeAssets() {
  const files: Record<string, [string, string]> = {
    '/index.html': [POWER_INDEX, 'text/html; charset=utf-8'],
    '/learn/index.html': [SIMPLE_INDEX, 'text/html; charset=utf-8'],
    '/learn/main-xyz.js': ['console.log(1)', 'text/javascript'],
    '/canvas/index.html': [CANVAS_INDEX, 'text/html; charset=utf-8'],
    '/canvas/main-abc.js': ['console.log(2)', 'text/javascript'],
  };
  const seen: string[] = [];
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const req = new Request(input, init);
      const path = new URL(req.url).pathname;
      seen.push(`${req.method} ${path}`);
      const file = files[path.endsWith('/') ? `${path}index.html` : path] ?? files['/index.html']!;
      return new Response(req.method === 'HEAD' ? null : file[0], {
        headers: { 'Content-Type': file[1], 'Cache-Control': 'public, max-age=0, must-revalidate' },
      });
    },
    connect(): never {
      throw new Error('not supported');
    },
  };
  return { fetcher: fetcher as unknown as Fetcher, seen };
}

function setup() {
  const assets = fakeAssets();
  const app = new Hono<AppBindings>();
  app.route('/', learnAppRoutes());
  app.route('/', canvasAppRoutes());
  app.get('/api/ping', (c) => c.json({ ok: true }));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  const e = { ...env, ASSETS: assets.fetcher } as AppEnv;
  const request = (path: string, init?: RequestInit) => app.request(`${ORIGIN}${path}`, init, e);
  return { request, seen: assets.seen };
}

function expectCommonHeaders(res: Response) {
  for (const [name, value] of Object.entries(LEARN_COMMON_HEADERS))
    expect(res.headers.get(name)).toBe(value);
}

describe('learnAppRoutes', () => {
  it('redirects /learn to /learn/ permanently', async () => {
    const { request, seen } = setup();
    const res = await request('/learn?x=1');
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/learn/?x=1');
    expect(seen).toEqual([]);
  });

  it('serves the simple index.html with the app CSP for client-side routes', async () => {
    const { request, seen } = setup();
    for (const path of ['/learn/', '/learn/t/abc', '/learn/billing']) {
      const res = await request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(SIMPLE_INDEX);
      expect(res.headers.get('Content-Security-Policy')).toBe(LEARN_APP_CSP);
      expectCommonHeaders(res);
    }
    expect(seen).toEqual(['GET /learn/', 'GET /learn/', 'GET /learn/']);
  });

  it('serves the login page with the login CSP (Turnstile, no Trusted Types)', async () => {
    const { request } = setup();
    for (const path of ['/learn/login', '/learn/login/']) {
      const res = await request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(SIMPLE_INDEX);
      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toBe(LEARN_LOGIN_CSP);
      expect(csp).toContain('https://challenges.cloudflare.com');
      expect(csp).not.toContain('trusted-types');
      expectCommonHeaders(res);
    }
  });

  it('passes asset paths through to ASSETS with nosniff', async () => {
    const { request, seen } = setup();
    const res = await request('/learn/main-xyz.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');
    expect(res.headers.get('Content-Type')).toBe('text/javascript');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(seen).toEqual(['GET /learn/main-xyz.js']);
  });

  it('404s a missing file instead of serving the SPA fallback document', async () => {
    const { request } = setup();
    const res = await request('/learn/missing-abc.js');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('power');
  });

  it('answers HEAD like GET', async () => {
    const { request } = setup();
    const res = await request('/learn/t/abc', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toBe(LEARN_APP_CSP);
  });

  it('leaves other paths alone', async () => {
    const { request, seen } = setup();
    const api = await request('/api/ping');
    expect(await api.json()).toEqual({ ok: true });
    expect(api.headers.get('Content-Security-Policy')).toBeNull();
    expect((await request('/learning')).status).toBe(404);
    expect((await request('/canvassing')).status).toBe(404);
    expect((await request('/learn/t/abc', { method: 'POST' })).status).toBe(404);
    expect(seen).toEqual([]);
  });
});

describe('canvasAppRoutes', () => {
  it('redirects /canvas to /canvas/ permanently', async () => {
    const { request, seen } = setup();
    const res = await request('/canvas?x=1');
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/canvas/?x=1');
    expect(seen).toEqual([]);
  });

  it('serves the canvas index.html with the app CSP for client-side routes', async () => {
    const { request, seen } = setup();
    for (const path of ['/canvas/', '/canvas/t/abc/b/def', '/canvas/demo/t/abc']) {
      const res = await request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(CANVAS_INDEX);
      expect(res.headers.get('Content-Security-Policy')).toBe(LEARN_APP_CSP);
      expectCommonHeaders(res);
    }
    expect(seen).toEqual(['GET /canvas/', 'GET /canvas/', 'GET /canvas/']);
  });

  it('serves its login page with the login CSP', async () => {
    const { request } = setup();
    const res = await request('/canvas/login');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CANVAS_INDEX);
    expect(res.headers.get('Content-Security-Policy')).toBe(LEARN_LOGIN_CSP);
  });

  it('passes asset paths through and 404s missing files', async () => {
    const { request, seen } = setup();
    const res = await request('/canvas/main-abc.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(2)');
    expect(seen).toEqual(['GET /canvas/main-abc.js']);
    expect((await request('/canvas/missing-abc.js')).status).toBe(404);
  });

  it('keeps the two apps apart', async () => {
    const { request } = setup();
    expect(await (await request('/learn/t/abc')).text()).toBe(SIMPLE_INDEX);
    expect(await (await request('/canvas/t/abc')).text()).toBe(CANVAS_INDEX);
  });
});

/**
 * The CSPs in learn-app.ts must match apps/web/public/_headers. The workers
 * pool can't read the host file system, so the file comes in through Vite's
 * `?raw` import (inlined as a string when the test module is transformed).
 */
describe('learn-app CSP matches _headers', () => {
  function headersFile(): Map<string, Map<string, string>> {
    const text: string = headersText;
    const rules = new Map<string, Map<string, string>>();
    let current: Map<string, string> | undefined;
    for (const line of text.split('\n')) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      if (!/^\s/.test(line)) {
        current = new Map();
        rules.set(line.trim(), current);
        continue;
      }
      const entry = line.trim();
      if (entry.startsWith('!')) continue; // detach rule, e.g. `! Content-Security-Policy`
      const colon = entry.indexOf(':');
      current!.set(entry.slice(0, colon).trim().toLowerCase(), entry.slice(colon + 1).trim());
    }
    return rules;
  }

  it('app policy and common headers equal the /* rule', () => {
    const all = headersFile().get('/*');
    expect(all).toBeDefined();
    expect(all!.get('content-security-policy')).toBe(LEARN_APP_CSP);
    for (const [name, value] of Object.entries(LEARN_COMMON_HEADERS))
      expect(all!.get(name.toLowerCase())).toBe(value);
  });

  it('login policy equals the /login rule', () => {
    const login = headersFile().get('/login');
    expect(login).toBeDefined();
    expect(login!.get('content-security-policy')).toBe(LEARN_LOGIN_CSP);
  });
});
