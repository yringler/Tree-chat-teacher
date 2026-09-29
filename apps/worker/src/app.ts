import type { MeResponse } from '@tangent/shared';
import { Hono } from 'hono';
import { accessMiddleware, type AccessMiddlewareOptions } from './auth/access.js';
import type { AppBindings } from './env.js';
import { notFound, onError } from './http/errors.js';

export interface AppOptions {
  access?: AccessMiddlewareOptions;
}

/** Builds the HTTP app. Routes beyond /api/me are added by later slices. */
export function createApp(options: AppOptions = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.onError(onError);
  app.notFound(notFound);

  app.use('/api/*', accessMiddleware(options.access));

  app.get('/api/me', (c) => {
    const { email, devMode } = c.var.identity;
    return c.json({ email, devMode } satisfies MeResponse);
  });

  return app;
}
