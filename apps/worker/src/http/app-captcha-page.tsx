import { Hono } from 'hono';
import { authBaseUrl } from '../auth/auth.js';
import { appConfig } from '../config.js';
import type { AppBindings } from '../env.js';
import { turnstileConfigured } from '../pool/turnstile.js';
import { pageResponse } from './layout.js';
import { LEARN_COMMON_HEADERS } from './learn-app.js';
import { APP_CAPTCHA_STYLE } from './page-styles.js';

/**
 * The Turnstile widget for the phone app. Turnstile checks the hostname of
 * the page a token was issued on, so the app can't run the widget itself: it
 * opens this page in a web view and gets the token from it, then requests the
 * sign-in email as the web login page does. The page's script hands each
 * result to the app's `TangentCaptcha` JavaScript channel: the token on a
 * pass, an empty message when it expires or fails (the app drops it; the
 * widget refreshes or retries on its own).
 */

const APP_CAPTCHA_PATH = '/app-captcha';
const APP_CAPTCHA_SCRIPT_PATH = '/app-captcha.js';

/** The widget's callbacks: globals, as Turnstile's implicit rendering names them. */
const PASSED = 'tangentCaptchaPassed';
const LAPSED = 'tangentCaptchaLapsed';

const APP_CAPTCHA_SCRIPT = `'use strict';
function tell(message) {
  if (window.TangentCaptcha) window.TangentCaptcha.postMessage(message);
}
window.${PASSED} = function (token) {
  tell(token);
};
window.${LAPSED} = function () {
  tell('');
};
`;

function AppCaptchaPage(props: { siteKey: string }) {
  return (
    <main class="wrap captcha">
      <p>Checking that you're a person, not a script.</p>
      <div
        class="cf-turnstile"
        data-sitekey={props.siteKey}
        data-callback={PASSED}
        data-expired-callback={LAPSED}
        data-error-callback={LAPSED}
      ></div>
    </main>
  );
}

/** `GET /app-captcha` and its script, mounted at the root by `createApp` (listed in run_worker_first). */
export function appCaptchaRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get(APP_CAPTCHA_PATH, (c) => {
    const siteKey = appConfig(c.env).auth.turnstileSiteKey;
    if (siteKey === null || !turnstileConfigured(c.env)) return c.notFound();
    return pageResponse(
      {
        path: APP_CAPTCHA_PATH,
        origin: authBaseUrl(c.env, c.req.raw),
        title: 'One quick check · Tangent',
        noindex: true,
        style: APP_CAPTCHA_STYLE,
        turnstile: true,
        script: APP_CAPTCHA_SCRIPT_PATH,
        bare: true,
      },
      <AppCaptchaPage siteKey={siteKey} />,
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });

  app.get(APP_CAPTCHA_SCRIPT_PATH, () => {
    return new Response(APP_CAPTCHA_SCRIPT, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        ...LEARN_COMMON_HEADERS,
      },
    });
  });

  return app;
}
