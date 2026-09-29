import { Hono } from 'hono';
import { accessMiddleware, type AccessMiddlewareOptions } from './auth/access.js';
import type { AppBindings } from './env.js';
import { notFound, onError } from './http/errors.js';
import { apiRoutes } from './routes/api.js';
import { shareRoutes } from './routes/share.js';

export interface AppOptions {
  access?: AccessMiddlewareOptions;
}

/**
 * The HTTP app. `/api/*` requires a verified Cloudflare Access JWT; `/s/*`
 * is public and read-only. Everything else is served by Workers Static
 * Assets before the Worker runs (see run_worker_first in wrangler.jsonc).
 */
export function createApp(options: AppOptions = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.onError(onError);
  app.notFound(notFound);
  app.use('/api/*', accessMiddleware(options.access));
  app.route('/api', apiRoutes());
  app.route('/s', shareRoutes());
  return app;
}
