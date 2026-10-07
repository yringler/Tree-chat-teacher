import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppBindings, AppEnv } from '../src/env.js';
import { LANDING_STYLE, hasSessionCookie, landingRoutes } from '../src/http/landing.js';
import { LEARN_APP_CSP } from '../src/http/learn-app.js';

const ORIGIN = 'https://tangent.example.com';
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
  const request = (path: string, init?: RequestInit) => app.request(`${ORIGIN}${path}`, init, e);
  return { request, seen: assets.seen };
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

async function expectLanding(res: Response, cacheControl: string) {
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('Cache-Control')).toBe(cacheControl);
  const html = await res.text();
  expect(html).toContain('<title>Tangent');
  return html;
}

describe('landingRoutes', () => {
  it('serves /welcome with a CSP whose style hash matches the inline stylesheet', async () => {
    const { request, seen } = setup();
    const res = await request('/welcome');
    const html = await expectLanding(res, 'public, max-age=300');
    expect(res.headers.get('Vary')).toBeNull();

    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
    expect(styles).toEqual([LANDING_STYLE]);
    const hash = await sha256Base64(styles[0]!);
    expect(res.headers.get('Content-Security-Policy')).toBe(
      `default-src 'none'; style-src 'sha256-${hash}'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    // No script of any kind, and no inline style attributes the CSP would block.
    expect(html).not.toMatch(/<script|\son\w+=|\sstyle=/i);
    expect(html).toContain('<link rel="canonical" href="https://tangent.example.com/">');
    expect(new TextEncoder().encode(html).length).toBeLessThan(25_000);
    expect(seen).toEqual([]);
  });

  it('links the three calls to action', async () => {
    const { request } = setup();
    const html = await (await request('/welcome')).text();
    expect(html).toContain('<a class="btn primary" href="/learn/demo">Try the demo</a>');
    expect(html).toContain('<a class="btn" href="/learn/login">Start learning</a>');
    expect(html).toContain('<a href="/login">Power users: sign in</a>');
  });

  it('links the pricing page from the header, the pricing card and the footer', async () => {
    const html = await (await setup().request('/welcome')).text();
    expect(html).toContain(
      '<a href="/login">Power sign in</a><a href="/pricing">Pricing</a></nav>',
    );
    expect(html).toContain(
      '<a href="/pricing">See exactly what’s free and what’s paid</a></p></article>',
    );
    expect(html).toContain('<a href="/welcome">About Tangent</a><a href="/pricing">Pricing</a>');
    // The fine print (fees, tax, the billing portal) is on /pricing, not here.
    expect(html).not.toMatch(/processing fee|tax is added|billing portal/i);
  });

  it('with the membership on: own keys stay free in Learn; power keys and buying credit need it', async () => {
    const off = await (
      await setup({ env: { ANNUAL_FEE_ENABLED: 'false' } }).request('/welcome')
    ).text();
    expect(off).not.toContain('membership');
    const { request } = setup({ env: { ANNUAL_FEE_ENABLED: 'true' } });
    const html = await (await request('/welcome')).text();
    expect(html).toContain(
      'Or pay per reply from prepaid credit (buying credit needs a membership)',
    );
    expect(html).toContain('With a yearly membership, you can also buy prepaid credit');
    expect(html).toContain('with nothing charged by Tangent and no membership needed');
    expect(html).toContain('Using your own keys here needs a yearly membership');
  });

  it('offers prepaid credit only where it is sold, and names the own-key providers', async () => {
    const sold = await (await setup({ env: { PROVIDERS: '' } }).request('/welcome')).text();
    expect(sold).toContain(
      'Or buy prepaid credit and pay for each reply at what it costs Tangent, plus 10%.',
    );
    expect(sold).toContain('<li>Or pay per reply from prepaid credit</li>');
    expect(sold).toContain('<li>Your own API keys for Anthropic, OpenAI or OpenRouter</li>');
    expect(sold).toContain('<li>Any OpenRouter model, on prepaid credit</li>');
    // Polar without its secrets: no payments, so nothing to buy.
    const unsold = await (
      await setup({ env: { PAYMENT_PROVIDER: 'polar' } }).request('/welcome')
    ).text();
    expect(unsold).not.toMatch(/prepaid credit|pay as you go/i);
    expect(unsold).toContain('<h3>Free, or on your own key</h3>');
  });

  it('describes web-search grounding as the GROUNDING ceiling allows, never as always on', async () => {
    const page = async (grounding: string) =>
      (await setup({ env: { GROUNDING: grounding } }).request('/welcome')).text();
    const auto = await page('auto');
    expect(auto).toContain('Checked against the web when you go deep');
    expect(auto).toContain('So when a reply needs it');
    expect(auto).toContain('<strong>Check sources</strong>');
    const explicit = await page('explicit');
    expect(explicit).toContain('Check any answer against the web');
    expect(explicit).not.toContain('So when a reply needs it');
    for (const off of ['off', 'typo']) {
      expect(await page(off)).not.toContain('Check sources');
    }
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
