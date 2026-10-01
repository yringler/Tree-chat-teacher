import type { LoginOptionsResponse } from '@tangent/shared';
import { Hono } from 'hono';
import { authConfigured, getAuth, openSignup, socialProviderFlags, type AuthDeps } from './auth/auth.js';
import { accountMiddleware } from './auth/account.js';
import { sessionMiddleware } from './auth/session.js';
import type { AppBindings } from './env.js';
import { apiError, notFound, onError } from './http/errors.js';
import { learnAppRoutes } from './http/learn-app.js';
import { apiRoutes } from './routes/api.js';
import { billingRoutes } from './routes/billing.js';
import { shareRoutes } from './routes/share.js';

export interface AppOptions {
  auth?: AuthDeps;
}

/**
 * The HTTP app.
 * - `/api/auth/*` is Better Auth (sign-in, callbacks, session, passkeys).
 * - `/api/login-options` is public: what the login page should offer.
 * - Every other `/api/*` route requires a session (auth/session.ts) and acts
 *   as the caller's account (auth/account.ts); `/api/billing/*` is the simple
 *   accounts' billing API.
 * - `/s/*` is public and read-only.
 * - `/learn`, `/learn/*` serve the simple app (http/learn-app.ts).
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
      openSignup: configured && openSignup(c.env),
    };
    return c.json(body);
  });

  app.use('/api/*', sessionMiddleware(options.auth));
  app.use('/api/*', accountMiddleware);
  app.route('/api/billing', billingRoutes());
  app.route('/api', apiRoutes());
  app.route('/s', shareRoutes());
  app.route('/', learnAppRoutes());
  return app;
}
