import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../env.js';
import { apiError } from '../http/errors.js';
import { authConfigured, getAuth, type AuthDeps } from './auth.js';

/**
 * Requires a Better Auth session on owner routes (`/api/*` except the auth
 * endpoints and login options). Fails closed: with no BETTER_AUTH_SECRET,
 * requests are refused unless DEV_ALLOW_NO_AUTH === 'true' (local dev only).
 *
 * The lookup never refreshes the session: a refresh must also re-issue the
 * cookie, which only Better Auth's own `GET /api/auth/get-session` does (the
 * web app calls it at startup). Refreshing here would push the database
 * expiry ahead while the cookie kept its old one.
 */
export function sessionMiddleware(deps: AuthDeps = {}) {
  return createMiddleware<AppBindings>(async (c, next) => {
    if (!authConfigured(c.env)) {
      if (c.env.DEV_ALLOW_NO_AUTH === 'true') {
        c.set('identity', { userId: null, email: null, devMode: true });
        return next();
      }
      return apiError(c, 'internal', 'Authentication is not configured');
    }

    const result = await getAuth(c.env, c.req.raw, deps).api.getSession({
      headers: c.req.raw.headers,
      query: { disableRefresh: true },
    });
    if (!result) return apiError(c, 'unauthorized', 'Sign in required');
    // Anyone may sign up, but only with a verified email: it is what makes the
    // accounts theirs, and what SERVER_KEY_EMAILS matches (auth/account.ts).
    // Users are only created verified, so this is a backstop.
    if (!result.user.emailVerified) {
      return apiError(c, 'forbidden', 'Sign in with a verified email address');
    }
    c.set('identity', { userId: result.user.id, email: result.user.email, devMode: false });
    return next();
  });
}
