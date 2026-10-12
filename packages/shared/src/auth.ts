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

/**
 * The login page's query parameter naming where a completed sign-in lands:
 * the page a signed-out visitor asked for. It travels in the URL rather than
 * a cookie because a magic link may be opened in another browser.
 */
export const RETURN_TO_PARAM = 'returnTo';

/** Longer targets than any page of ours needs are refused rather than carried around. */
const RETURN_TO_MAX = 2048;
/** An encoded `/` or `\` in the path, which some routers and proxies decode into a separator. */
const ENCODED_SEPARATOR = /%2f|%5c/i;
const PARSER_ORIGIN = 'https://return-to.invalid';

/** C0 and C1 controls and DEL: URL parsers drop some (tab, newline) and treat others as separators. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * `raw` when it is a path on this origin (path, query and hash), else null.
 * Only a root-relative path is accepted: it starts with a single `/`, has no
 * backslash, control character or encoded separator in its path, and still
 * resolves to this origin. Anything else (`//host`, `/\host`, a scheme, an
 * absolute URL) could send a freshly signed-in user to another site.
 * Better Auth checks its callback URLs by the same rules, so a target that
 * passes here is one it accepts.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > RETURN_TO_MAX) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (raw.includes('\\') || hasControlCharacter(raw)) return null;
  const pathEnd = raw.search(/[?#]/);
  if (ENCODED_SEPARATOR.test(pathEnd === -1 ? raw : raw.slice(0, pathEnd))) return null;
  try {
    return new URL(raw, PARSER_ORIGIN).origin === PARSER_ORIGIN ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The login page at `loginPath` with the sign-in's return target (dropped
 * unless `safeReturnPath` accepts it) and an `?error=` code to show.
 */
export function loginUrl(
  loginPath: string,
  params: { returnTo?: string | null; error?: string },
): string {
  const query = new URLSearchParams();
  if (params.error) query.set('error', params.error);
  const returnTo = safeReturnPath(params.returnTo);
  if (returnTo) query.set(RETURN_TO_PARAM, returnTo);
  const search = query.toString();
  return search ? `${loginPath}?${search}` : loginPath;
}
