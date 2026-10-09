import { escapeHtml } from '@tangent/render';
import { Hono, type Context } from 'hono';
import { authBaseUrl, turnstileHostname, type AuthDeps } from '../auth/auth.js';
import { clientIp } from '../auth/account.js';
import { optionalIdentity } from '../auth/session.js';
import { sameOriginOnly } from '../byok/guard.js';
import { appConfig } from '../config.js';
import type { SqlRow } from '../db/rows.js';
import type { authUsers } from '../db/schema.js';
import type { AppBindings } from '../env.js';
import { markPoolVerified } from '../pool/identity.js';
import {
  safeNextPath,
  TURNSTILE_ACTION,
  turnstileConfigured,
  VERIFY_PAGE_PATH,
  verifyTurnstile,
} from '../pool/turnstile.js';
import { LEARN_COMMON_HEADERS } from './learn-app.js';
import { LEGAL_STYLE } from './legal.js';
import { MARK, sha256Base64 } from './landing.js';

/**
 * The Turnstile interstitial after a first OAuth sign-in (auth/auth.ts sends
 * the callback here). A server-rendered form with
 * Cloudflare's widget and no script of our own: the widget puts its token in
 * the form as `cf-turnstile-response`, the form posts back here, and a pass
 * records `auth_users.pool_verified_at` (and the pool identity) before
 * continuing to `next`. Anyone who isn't signed in, is already verified, or
 * meets a deployment without Turnstile just continues.
 */

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** Extra rules on top of the legal pages' stylesheet. Hashed for the CSP. */
export const VERIFY_STYLE =
  LEGAL_STYLE +
  `
.verify{max-width:30rem;padding-top:48px;padding-bottom:64px}
.verify form{display:grid;gap:16px;justify-items:start;margin-top:24px}
.verify .error{color:#c0392b;font-weight:600}
`;

let csp: Promise<string> | null = null;

/** The page's one hashed stylesheet, Turnstile's script and iframe, and a same-origin form. */
export function verifyPageCsp(): Promise<string> {
  csp ??= sha256Base64(VERIFY_STYLE).then(
    (hash) =>
      `default-src 'none'; style-src 'sha256-${hash}'; script-src ${TURNSTILE_ORIGIN}; ` +
      `frame-src ${TURNSTILE_ORIGIN}; img-src 'self' data:; base-uri 'none'; ` +
      "form-action 'self'; frame-ancestors 'none'",
  );
  return csp;
}

export function renderVerifyPage(opts: { siteKey: string; next: string; failed: boolean }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>One quick check · Tangent</title>
<style>${VERIFY_STYLE}</style>
<script src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js" async defer></script>
</head>
<body>
<header class="wrap top">
<a class="brand" href="/welcome">${MARK}Tangent</a>
</header>
<main class="wrap doc verify">
<h1>One quick check</h1>
<p>Before your first visit we check that you're a person, not a script. It keeps the open pool for learners.</p>
${opts.failed ? '<p class="error" role="alert">That check didn\'t go through. Please try again.</p>' : ''}
<form method="post" action="${VERIFY_PAGE_PATH}">
<input type="hidden" name="next" value="${escapeHtml(opts.next)}">
<div class="cf-turnstile" data-sitekey="${escapeHtml(opts.siteKey)}" data-action="${TURNSTILE_ACTION}"></div>
<button class="btn primary" type="submit">Continue</button>
</form>
</main>
</body>
</html>
`;
}

async function pageResponse(html: string, status: 200 | 400): Promise<Response> {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': await verifyPageCsp(),
      'Cache-Control': 'no-store',
      ...LEARN_COMMON_HEADERS,
    },
  });
}

/** The Turnstile site key; set wherever the page is shown (`turnstileConfigured`). */
function siteKey(c: Context<AppBindings>): string {
  return appConfig(c.env).auth.turnstileSiteKey ?? '';
}

/** Whether `userId` has a Turnstile pass on record. */
async function isVerified(c: Context<AppBindings>, userId: string): Promise<boolean> {
  const row = await c.env.DB.prepare('SELECT pool_verified_at FROM auth_users WHERE id = ?')
    .bind(userId)
    .first<Pick<SqlRow<typeof authUsers>, 'pool_verified_at'>>();
  return !!row?.pool_verified_at;
}

/** `GET` and `POST /verify`, mounted at the root by `createApp` (listed in run_worker_first). */
export function verifyPageRoutes(deps: AuthDeps = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get(VERIFY_PAGE_PATH, async (c) => {
    const origin = new URL(authBaseUrl(c.env, c.req.raw)).origin;
    const next = safeNextPath(c.req.query('next'), origin);
    const identity = await optionalIdentity(c.env, c.req.raw, deps);
    if (!identity?.userId || !turnstileConfigured(c.env) || (await isVerified(c, identity.userId)))
      return c.redirect(next, 303);
    return pageResponse(renderVerifyPage({ siteKey: siteKey(c), next, failed: false }), 200);
  });

  app.post(VERIFY_PAGE_PATH, sameOriginOnly, async (c) => {
    const origin = new URL(authBaseUrl(c.env, c.req.raw)).origin;
    const form = await c.req.parseBody();
    const next = safeNextPath(typeof form.next === 'string' ? form.next : null, origin);
    const identity = await optionalIdentity(c.env, c.req.raw, deps);
    if (!identity?.userId || !identity.email || !turnstileConfigured(c.env))
      return c.redirect(next, 303);
    const token = form['cf-turnstile-response'];
    const passed =
      typeof token === 'string' &&
      (await verifyTurnstile(c.env, token, clientIp(c.req.raw.headers), {
        action: TURNSTILE_ACTION,
        hostname: turnstileHostname(c.env, c.req.raw),
      }));
    if (!passed)
      return pageResponse(renderVerifyPage({ siteKey: siteKey(c), next, failed: true }), 400);
    // A mailbox another account already uses still continues; the pool gate refuses it.
    await markPoolVerified(c.env.DB, identity.userId, identity.email);
    return c.redirect(next, 303);
  });

  return app;
}
