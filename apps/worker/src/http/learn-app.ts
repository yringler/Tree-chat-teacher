import { Hono, type Context } from 'hono';
import type { AppBindings } from '../env.js';

/**
 * Content-Security-Policy for the simple app's documents. Must stay identical
 * to the `/*` policy in apps/web/public/_headers (test/learn-app.test.ts
 * compares them): Workers Static Assets doesn't apply `_headers` to responses
 * the Worker generates, so the Worker sets these itself.
 */
export const LEARN_APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types angular angular#bundler";

/**
 * The login page's policy, identical to the `/login` policy in `_headers`:
 * Cloudflare Turnstile's script and iframe are allowed, Trusted Types is not
 * enforced, and the page holds no conversations.
 */
export const LEARN_LOGIN_CSP =
  "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/** The other headers `_headers` sets on every response under `/*`. */
export const LEARN_COMMON_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

const BASE = '/learn/';

/** True when the last path segment looks like a file name (`main-xyz.js`, `favicon.ico`). */
function isAssetPath(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return last.includes('.');
}

function isLoginPath(pathname: string): boolean {
  return pathname === '/learn/login' || pathname === '/learn/login/';
}

/** Copies `res` with the security headers set (fetched responses have immutable headers). */
function withHeaders(res: Response, csp: string): Response {
  const out = new Response(res.body, res);
  out.headers.set('Content-Security-Policy', csp);
  for (const [name, value] of Object.entries(LEARN_COMMON_HEADERS)) out.headers.set(name, value);
  return out;
}

/**
 * Serves the simple app under `/learn/` (PLAN §2.8), mounted at the root by
 * `createApp`. `run_worker_first` sends `/learn` and `/learn/*` here, because
 * the assets' SPA fallback only ever serves the root (power app) index.html.
 * - `/learn` → 301 `/learn/`.
 * - A path whose last segment contains a `.` is a file: passed to ASSETS as is.
 * - Every other path is a client-side route: the simple app's index.html
 *   (`/learn/`), with the login CSP on `/learn/login` and the app CSP elsewhere.
 * Every response carries the headers `_headers` would have given it.
 */
export function learnAppRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.on(['GET', 'HEAD'], '/learn', (c) => {
    const url = new URL(c.req.url);
    return c.redirect(`${BASE}${url.search}`, 301);
  });

  app.on(['GET', 'HEAD'], '/learn/*', async (c: Context<AppBindings>) => {
    const req = c.req.raw;
    const url = new URL(req.url);
    if (isAssetPath(url.pathname)) {
      const res = await c.env.ASSETS.fetch(req);
      // A missing file falls through to the SPA fallback (the power app's
      // index.html, 200). Don't serve a document where a file was asked for.
      const type = res.headers.get('Content-Type') ?? '';
      if (res.ok && type.startsWith('text/html') && !url.pathname.endsWith('.html')) {
        return withHeaders(new Response('Not found', { status: 404 }), LEARN_APP_CSP);
      }
      return withHeaders(res, LEARN_APP_CSP);
    }
    // Same method and headers (conditional requests keep working), but always
    // the simple app's entry document.
    const index = await c.env.ASSETS.fetch(
      new Request(`${url.origin}${BASE}`, { method: req.method, headers: req.headers }),
    );
    return withHeaders(index, isLoginPath(url.pathname) ? LEARN_LOGIN_CSP : LEARN_APP_CSP);
  });

  return app;
}
