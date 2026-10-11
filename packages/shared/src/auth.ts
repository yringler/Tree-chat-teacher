/** Where Better Auth is mounted on the Worker, and where its browser client calls. */
export const AUTH_BASE_PATH = '/api/auth';

/**
 * Set by the login page right before a sign-in starts, on AUTH_BASE_PATH:
 * `1` = remember me (a persistent session cookie), anything else = a
 * browser-session cookie. It's a plain preference cookie because the OAuth
 * callback and the magic link arrive as top-level navigations that can't
 * carry a request body.
 */
export const REMEMBER_COOKIE = 'tangent-remember';

/**
 * The error code of a sign-up refused because the deployment has as many
 * users as `MAX_USERS` allows: the magic-link request answers with it, and
 * the OAuth callback and magic-link verify redirect to the login page with it
 * as `?error=`. Existing users still sign in.
 */
export const SIGNUPS_CLOSED = 'signups_closed';
