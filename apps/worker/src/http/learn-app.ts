import { Hono, type Context } from 'hono';
import { isAdmin } from '../auth/admin.js';
import type { AuthDeps } from '../auth/auth.js';
import { optionalIdentity } from '../auth/session.js';
import type { AppBindings } from '../env.js';

/**
 * Content-Security-Policy for the documents of the apps the Worker serves
 * itself (the simple app under /learn/, the canvas app under /canvas/, the
 * admin app under /admin/).
 * Must stay identical to the `/*` policy in apps/web/public/_headers
 * (test/learn-app.test.ts compares them): Workers Static Assets doesn't
 * apply `_headers` to responses the Worker generates, so the Worker sets
 * these itself.
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

/** The base paths of the Angular apps the Worker serves (PLAN §2.8). */
export const LEARN_BASE = '/learn/';
export const CANVAS_BASE = '/canvas/';
export const ADMIN_BASE = '/admin/';

/** True when the last path segment looks like a file name (`main-xyz.js`, `favicon.ico`). */
function isAssetPath(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return last.includes('.');
}

function isLoginPath(base: string, pathname: string): boolean {
  return pathname === `${base}login` || pathname === `${base}login/`;
}

/** Copies `res` with the security headers set (fetched responses have immutable headers). */
function withHeaders(res: Response, csp: string, noStore = false): Response {
  const out = new Response(res.body, res);
  out.headers.set('Content-Security-Policy', csp);
  for (const [name, value] of Object.entries(LEARN_COMMON_HEADERS)) out.headers.set(name, value);
  if (noStore) out.headers.set('Cache-Control', 'no-store');
  return out;
}

function notFoundPage(): Response {
  return withHeaders(new Response('Not found', { status: 404 }), LEARN_APP_CSP);
}

export interface SpaAppOptions {
  /** The app has its own `<base>login` page (served with the login CSP). Default true. */
  login?: boolean;
  /**
   * Who may load the app's documents (the base and its client-side routes;
   * files are served to anyone). Anyone else gets a plain 404, and the
   * documents they may load are never stored by the browser. Default: everyone.
   */
  allow?: (c: Context<AppBindings>) => Promise<boolean>;
}

/**
 * Serves one Angular app under `base` (`/learn/`, `/canvas/` or `/admin/`), mounted at
 * the root by `createApp`. `run_worker_first` sends the base and everything
 * under it here, because the assets' SPA fallback only ever serves the root
 * (power app) index.html.
 * - the base without its slash → 301 to the base.
 * - A path whose last segment contains a `.` is a file: passed to ASSETS as is.
 * - Every other path is a client-side route: the app's index.html, with the
 *   login CSP on `<base>login` (apps with a login page) and the app CSP elsewhere.
 * `options.allow` limits the redirect and the documents to some callers.
 * Every response carries the headers `_headers` would have given it.
 */
export function spaAppRoutes(base: string, options: SpaAppOptions = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const bare = base.slice(0, -1);
  const { login = true, allow } = options;

  app.on(['GET', 'HEAD'], bare, async (c) => {
    if (allow && !(await allow(c))) return notFoundPage();
    const url = new URL(c.req.url);
    return c.redirect(`${base}${url.search}`, 301);
  });

  app.on(['GET', 'HEAD'], `${base}*`, async (c: Context<AppBindings>) => {
    const req = c.req.raw;
    const url = new URL(req.url);
    if (isAssetPath(url.pathname)) {
      const res = await c.env.ASSETS.fetch(req);
      // A missing file falls through to the SPA fallback (the power app's
      // index.html, 200). Don't serve a document where a file was asked for.
      const type = res.headers.get('Content-Type') ?? '';
      if (res.ok && type.startsWith('text/html') && !url.pathname.endsWith('.html')) {
        return notFoundPage();
      }
      return withHeaders(res, LEARN_APP_CSP);
    }
    if (allow && !(await allow(c))) return notFoundPage();
    // Same method and headers (conditional requests keep working), but always
    // the app's entry document.
    const index = await c.env.ASSETS.fetch(
      new Request(`${url.origin}${base}`, { method: req.method, headers: req.headers }),
    );
    const csp = login && isLoginPath(base, url.pathname) ? LEARN_LOGIN_CSP : LEARN_APP_CSP;
    return withHeaders(index, csp, !!allow);
  });

  return app;
}

/** The simple app under `/learn/`. */
export function learnAppRoutes(): Hono<AppBindings> {
  return spaAppRoutes(LEARN_BASE);
}

/** The experimental canvas app under `/canvas/`. */
export function canvasAppRoutes(): Hono<AppBindings> {
  return spaAppRoutes(CANVAS_BASE);
}

/**
 * The admin app under `/admin/`, for admins only (`isAdmin`: ADMIN_USER_IDS,
 * or the local dev bypass). Everyone else, signed out included, gets a 404,
 * as from `/api/admin/*`: neither says the app exists. It has no login page
 * of its own: an admin signs in to the power app first. Its files (scripts,
 * styles) are served to anyone; they hold no data.
 */
export function adminAppRoutes(deps: AuthDeps = {}): Hono<AppBindings> {
  return spaAppRoutes(ADMIN_BASE, {
    login: false,
    allow: async (c) => {
      const identity = await optionalIdentity(c.env, c.req.raw, deps);
      return !!identity && isAdmin(c.env, identity);
    },
  });
}
