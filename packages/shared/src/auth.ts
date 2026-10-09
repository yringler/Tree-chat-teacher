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
