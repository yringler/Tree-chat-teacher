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
import { pageResponse } from './layout.js';
import { VERIFY_STYLE } from './page-styles.js';

/**
 * The Turnstile interstitial after a first OAuth sign-in (auth/auth.ts sends
 * the callback here). A server-rendered form with
 * Cloudflare's widget and no script of our own: the widget puts its token in
 * the form as `cf-turnstile-response`, the form posts back here, and a pass
 * records `auth_users.pool_verified_at` (and the pool identity) before
 * continuing to `next`. Anyone who isn't signed in, is already verified, or
 * meets a deployment without Turnstile just continues.
 */

interface VerifyProps {
  siteKey: string;
  next: string;
  failed: boolean;
}

function VerifyPage(props: VerifyProps) {
  return (
    <main class="wrap doc verify">
      <h1>One quick check</h1>
      <p>
        Before your first visit we check that you're a person, not a script. It keeps the open pool
        for learners.
      </p>
      {props.failed && (
        <p class="error" role="alert">
          That check didn't go through. Please try again.
        </p>
      )}
      <form method="post" action={VERIFY_PAGE_PATH}>
        <input type="hidden" name="next" value={props.next} />
        <div class="cf-turnstile" data-sitekey={props.siteKey} data-action={TURNSTILE_ACTION}></div>
        <button class="btn primary" type="submit">
          Continue
        </button>
      </form>
    </main>
  );
}

function verifyResponse(c: Context<AppBindings>, page: VerifyProps): Promise<Response> {
  return pageResponse(
    {
      path: VERIFY_PAGE_PATH,
      origin: authBaseUrl(c.env, c.req.raw),
      title: 'One quick check · Tangent',
      noindex: true,
      style: VERIFY_STYLE,
      turnstile: true,
    },
    <VerifyPage {...page} />,
    { status: page.failed ? 400 : 200, headers: { 'Cache-Control': 'no-store' } },
  );
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
    return verifyResponse(c, { siteKey: siteKey(c), next, failed: false });
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
    if (!passed) return verifyResponse(c, { siteKey: siteKey(c), next, failed: true });
    // A mailbox another account already uses still continues; the pool gate refuses it.
    await markPoolVerified(c.env.DB, identity.userId, identity.email);
    return c.redirect(next, 303);
  });

  return app;
}
