import type { LoginOptionsResponse } from '@tangent/shared';
import { Hono } from 'hono';
import { authConfigured, getAuth, socialProviderFlags, type AuthDeps } from './auth/auth.js';
import { accountMiddleware } from './auth/account.js';
import { sessionMiddleware } from './auth/session.js';
import { sameOriginWrites } from './byok/guard.js';
import type { AppBindings } from './env.js';
import { apiError, notFound, onError } from './http/errors.js';
import { landingRoutes } from './http/landing.js';
import { adminAppRoutes, canvasAppRoutes, learnAppRoutes } from './http/learn-app.js';
import { legalRoutes } from './http/legal.js';
import { poolPageRoutes } from './http/pool-page.js';
import { pricingPageRoutes } from './http/pricing-page.js';
import { verifyPageRoutes } from './http/verify-page.js';
import { adminRoutes } from './routes/admin.js';
import { apiRoutes } from './routes/api.js';
import { billingRoutes } from './routes/billing.js';
import { paymentWebhookRoute } from './routes/payment-webhooks.js';
import { poolRoutes, poolStatusRoute } from './routes/pool.js';
import { shareRoutes } from './routes/share.js';

export interface AppOptions {
  auth?: AuthDeps;
}

/**
 * The HTTP app.
 * - `/api/auth/*` is Better Auth (sign-in, callbacks, session, passkeys).
 * - `/api/login-options` is public: what the login page should offer,
 *   and `/api/pool/status` the open pool's meter (routes/pool.ts).
 * - `POST /api/webhooks/:provider` is public too: payment provider webhooks,
 *   verified by their signature (routes/payment-webhooks.ts).
 * - Every other `/api/*` request but GET, HEAD and OPTIONS must be
 *   same-origin (`sameOriginWrites`, byok/guard.ts), sign-in included.
 * - Every other `/api/*` route requires a session (auth/session.ts) and acts
 *   as the caller's account for the app named by the `x-tangent-mode` header
 *   (auth/account.ts); `/api/billing/*` is the billing API, `/api/pool/*` the
 *   open pool's (routes/pool.ts), and `/api/admin/*` the admin API
 *   (admins only, routes/admin.ts).
 * - `/s/*` is public and read-only.
 * - `/learn`, `/learn/*` serve the simple app, `/canvas`, `/canvas/*` the
 *   canvas app and `/admin`, `/admin/*` the admin app, to admins only
 *   (http/learn-app.ts).
 * - `/privacy` and `/terms` are the public legal pages (http/legal.ts), and
 *   `/pool` explains the open pool (http/pool-page.ts) and `/pricing`
 *   what each plan gets you (http/pricing-page.ts).
 * - `/verify` is the Turnstile interstitial after a first OAuth sign-in
 *   (http/verify-page.ts).
 * - `/welcome`, and `/` for anonymous visitors, serve the landing page
 *   (http/landing.ts); `/` with a session cookie is the power app's index.
 * Everything else is served by Workers Static Assets before the Worker runs
 * (see run_worker_first in wrangler.jsonc).
 *
 * Hono runs matching handlers in registration order and stops at the first
 * response, so the public routes must be registered before the session check.
 */
export function createApp(options: AppOptions = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.onError(onError);
  app.notFound(notFound);

  // Payment webhooks come from the provider's servers, verified by their signature;
  // every other API write must come from this origin (sameOriginWrites).
  app.post('/api/webhooks/:provider', paymentWebhookRoute);
  app.use('/api/*', sameOriginWrites);

  app.on(['GET', 'POST'], '/api/auth/*', (c) => {
    if (!authConfigured(c.env)) return apiError(c, 'internal', 'Authentication is not configured');
    return getAuth(c.env, c.req.raw, options.auth).handler(c.req.raw);
  });
  app.get('/api/login-options', (c) => {
    const configured = authConfigured(c.env);
    const body: LoginOptionsResponse = {
      configured,
      devMode: !configured && c.env.DEV_ALLOW_NO_AUTH === 'true',
      social: configured ? socialProviderFlags(c.env) : { google: false, github: false },
      turnstileSiteKey: c.env.TURNSTILE_SITE_KEY?.trim() || null,
    };
    return c.json(body);
  });

  app.get('/api/pool/status', poolStatusRoute);

  app.use('/api/*', sessionMiddleware(options.auth));
  app.use('/api/*', accountMiddleware);
  app.route('/api/billing', billingRoutes());
  app.route('/api/admin', adminRoutes());
  app.route('/api/pool', poolRoutes());
  app.route('/api', apiRoutes());
  app.route('/s', shareRoutes());
  app.route('/', learnAppRoutes());
  app.route('/', canvasAppRoutes());
  app.route('/', adminAppRoutes(options.auth));
  app.route('/', legalRoutes());
  app.route('/', poolPageRoutes());
  app.route('/', pricingPageRoutes());
  app.route('/', verifyPageRoutes(options.auth));
  app.route('/', landingRoutes());
  return app;
}
