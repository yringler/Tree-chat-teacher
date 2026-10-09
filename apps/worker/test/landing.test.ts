import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppBindings, AppEnv } from '../src/env.js';
import { hasSessionCookie, landingRoutes } from '../src/http/landing.js';
import { LEARN_APP_CSP } from '../src/http/learn-app.js';
import { BASE } from './http.js';

const POWER_INDEX = '<!doctype html><title>power</title>';
const SECRET = 'test-secret-test-secret-test-secret';

/** Stand-in for Workers Static Assets: every path is the power app's index.html. */
function fakeAssets() {
  const seen: string[] = [];
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const req = new Request(input, init);
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      return new Response(req.method === 'HEAD' ? null : POWER_INDEX, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=0, must-revalidate',
        },
      });
    },
    connect(): never {
      throw new Error('not supported');
    },
  };
  return { fetcher: fetcher as unknown as Fetcher, seen };
}

/**
 * The landing routes plus a catch-all, so a request they don't handle shows
 * up as 404 `fallthrough`. Auth is configured unless `devBypass` is set (the
 * test pool's own env is the dev bypass).
 */
function setup(options: { devBypass?: boolean; env?: Partial<AppEnv> } = {}) {
  const assets = fakeAssets();
  const app = new Hono<AppBindings>();
  app.route('/', landingRoutes());
  app.notFound((c) => c.text('fallthrough', 404));
  const e = {
    ...env,
    ASSETS: assets.fetcher,
    BETTER_AUTH_SECRET: options.devBypass ? '' : SECRET,
    DEV_ALLOW_NO_AUTH: 'true',
    ...options.env,
  } as AppEnv;
  const request = (path: string, init?: RequestInit) => app.request(`${BASE}${path}`, init, e);
  return { request, seen: assets.seen };
}

async function expectLanding(res: Response, cacheControl: string) {
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  expect(res.headers.get('Content-Security-Policy')).toContain("style-src 'sha256-");
  expect(res.headers.get('Cache-Control')).toBe(cacheControl);
  const html = await res.text();
  expect(html).toContain('<title>Tangent');
  return html;
}

describe('landingRoutes', () => {
  it('serves /welcome to anyone, cacheable, without reading the assets', async () => {
    const { request, seen } = setup();
    const res = await request('/welcome');
    await expectLanding(res, 'public, max-age=300');
    expect(res.headers.get('Vary')).toBeNull();
    expect(seen).toEqual([]);
  });

  it('serves the landing page at / to an anonymous visitor, uncached', async () => {
    const { request, seen } = setup();
    const res = await request('/', { headers: { Cookie: 'theme=dark; tangent-remember=1' } });
    await expectLanding(res, 'no-cache');
    expect(res.headers.get('Vary')).toBe('Cookie');
    expect(seen).toEqual([]);
  });

  it('passes / through to the power app when a session cookie is present', async () => {
    for (const cookie of [
      'tangent.session_token=x',
      'a=b; __Secure-tangent.session_token=abc.def',
    ]) {
      const { request, seen } = setup();
      const res = await request('/', { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(POWER_INDEX);
      // _headers doesn't apply to Worker responses: the Worker sets the `/*` rule itself.
      expect(res.headers.get('Content-Security-Policy')).toBe(LEARN_APP_CSP);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
      expect(res.headers.get('Vary')).toBe('Cookie');
      expect(seen).toEqual(['GET /']);
    }
  });

  it('passes / through in dev bypass mode, but still serves /welcome', async () => {
    const { request, seen } = setup({ devBypass: true });
    const res = await request('/');
    expect(await res.text()).toBe(POWER_INDEX);
    expect(seen).toEqual(['GET /']);
    await expectLanding(await request('/welcome'), 'public, max-age=300');
  });

  it('answers HEAD like GET without a body', async () => {
    const { request, seen } = setup();
    const landing = await request('/', { method: 'HEAD' });
    expect(landing.status).toBe(200);
    expect(landing.headers.get('Content-Security-Policy')).toContain("style-src 'sha256-");
    expect(await landing.text()).toBe('');
    const welcome = await request('/welcome', { method: 'HEAD' });
    expect(welcome.status).toBe(200);
    const app = await request('/', {
      method: 'HEAD',
      headers: { Cookie: 'tangent.session_token=x' },
    });
    expect(app.status).toBe(200);
    expect(app.headers.get('Content-Security-Policy')).toBe(LEARN_APP_CSP);
    expect(seen).toEqual(['HEAD /']);
  });

  it('leaves other methods and paths alone', async () => {
    const { request, seen } = setup();
    for (const [path, method] of [
      ['/', 'POST'],
      ['/welcome', 'POST'],
      ['/welcome/x', 'GET'],
      ['/index.html', 'GET'],
    ] as const) {
      const res = await request(path, { method });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('fallthrough');
    }
    expect(seen).toEqual([]);
  });
});

describe('hasSessionCookie', () => {
  it('matches only a non-empty Better Auth session cookie', () => {
    expect(hasSessionCookie(null)).toBe(false);
    expect(hasSessionCookie('')).toBe(false);
    expect(hasSessionCookie('tangent.session_token=')).toBe(false);
    expect(hasSessionCookie('tangent.session_data=x; tangent-remember=1')).toBe(false);
    expect(hasSessionCookie('xtangent.session_token=x')).toBe(false);
    expect(hasSessionCookie('tangent.session_token=x')).toBe(true);
    expect(hasSessionCookie('a=1;  __Secure-tangent.session_token = y')).toBe(true);
  });
});
