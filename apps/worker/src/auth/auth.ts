import { passkey } from '@better-auth/passkey';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { captcha } from 'better-auth/plugins';
import { bearer } from 'better-auth/plugins/bearer';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { magicLink } from 'better-auth/plugins/magic-link';
import { drizzle } from 'drizzle-orm/d1';
import {
  AUTH_BASE_PATH,
  REMEMBER_COOKIE,
  SIGN_IN_CODE_LENGTH,
  SIGNUPS_CLOSED,
} from '@tangent/shared';
import {
  authAccounts,
  authPasskeys,
  authRateLimits,
  authSessions,
  authUsers,
  authVerifications,
} from '../db/schema.js';
import { KEY_COOKIE_ATTRIBUTES, KEY_COOKIE_NAME } from '../byok/keys.js';
import { appConfig } from '../config.js';
import { createEmailSender, magicLinkEmail, type EmailSender } from '../email/index.js';
import type { SqlRow } from '../db/rows.js';
import type { AppEnv } from '../env.js';
import { markPoolVerified } from '../pool/identity.js';
import {
  safeNextPath,
  turnstileConfigured,
  verifyPageUrl,
  verifyTurnstile,
} from '../pool/turnstile.js';

/**
 * Better Auth (https://better-auth.com), mounted at `/api/auth/*`.
 *
 * Sign-in methods: Google, GitHub, email (a magic link, or the code that comes
 * in the same email) and passkeys. There are no passwords: the
 * email+password method is never enabled. Passkeys are added from the
 * account dialog once signed in, then work as a sign-in method.
 *
 * The session is Better Auth's HttpOnly cookie. A client without cookies
 * (the phone app) signs in by code or with a Google ID token and keeps the
 * signed session token itself, sending it as `Authorization: Bearer <token>`.
 *
 * Anyone may sign up until the deployment has `MAX_USERS` users; abuse is
 * bounded by Turnstile and the rate limits on magic links. While the open
 * pool is on, Turnstile runs on every first sign-in: a magic link can only be
 * requested with
 * a Turnstile pass, so signing in with one records it
 * (`auth_users.pool_verified_at`); a first OAuth sign-in (or any OAuth
 * sign-in of a user with no pass on record) is sent through the Turnstile
 * interstitial (http/verify-page.tsx) on its way to the app. A user needs a
 * verified email (OAuth providers report it, a magic link proves it):
 * unverified users are never created. Each user has one
 * account in every app (auth/account.ts). Power mode is bring-your-own-key for
 * every signed-in user: the server's provider keys serve only the local dev bypass.
 *
 * Payments don't go through Better Auth: the membership, top-ups and the
 * payment provider's webhooks are billing routes (billing/payments).
 */

const DAY_SECONDS = 24 * 60 * 60;
/** Remembered sessions: 30 days, extended by activity (at most once a day). */
const SESSION_DAYS = 30;
export const MAGIC_LINK_MINUTES = 15;

/** Signs in with the code from the sign-in email (the email-OTP plugin's endpoint). */
const CODE_SIGN_IN_PATH = '/sign-in/email-otp';

/**
 * Starts an OAuth sign-in (a browser), or, with an `idToken` in the body,
 * signs in with an ID token the provider issued to the phone app.
 */
const SOCIAL_SIGN_IN_PATH = '/sign-in/social';

/** An app's sign-in: it hands out the bearer token, and needs no cookie to be remembered. */
function isAppSignIn(path: string | undefined): boolean {
  return path === CODE_SIGN_IN_PATH || path === SOCIAL_SIGN_IN_PATH;
}

function hasIdToken(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'idToken' in body;
}

/**
 * The response header that carries the signed session token to a client that
 * signed in by code (Better Auth's bearer plugin names it so).
 */
const BEARER_TOKEN_HEADER = 'set-auth-token';

/**
 * The email-OTP plugin's endpoints other than signing in by code. Each would
 * send a code without the captcha the magic-link request has, verify an
 * email, or set a password, none of which Tangent does.
 */
const UNUSED_EMAIL_OTP_PATHS = [
  '/email-otp/send-verification-otp',
  '/email-otp/check-verification-otp',
  '/email-otp/verify-email',
  '/email-otp/request-password-reset',
  '/forget-password/email-otp',
  '/email-otp/reset-password',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
];

/** Endpoints that finish a sign-in (and create the session). */
function isSignInCompletion(path: string | undefined): boolean {
  return (
    path === '/magic-link/verify' ||
    path === CODE_SIGN_IN_PATH ||
    // Only an ID token sign-in here makes a session; starting a redirect doesn't.
    path === SOCIAL_SIGN_IN_PATH ||
    path === '/passkey/verify-authentication' ||
    (path?.startsWith('/callback/') ?? false)
  );
}

// ---- Configuration

export interface AuthDeps {
  /** Test hook: replaces the env-selected email service. */
  emailSender?: EmailSender;
}

/** True when authentication is configured, i.e. the dev bypass can't apply. */
export function authConfigured(env: AppEnv): boolean {
  return appConfig(env).auth.secret !== null;
}

/** PUBLIC_BASE_URL, or the request's origin when it's unset (local dev and tests). */
export function authBaseUrl(env: AppEnv, request: Request): string {
  const configured = appConfig(env).site.publicBaseUrl?.replace(/\/+$/, '');
  return configured || new URL(request.url).origin;
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * The hostname a Turnstile token must have been issued for: `hostname`, this
 * deployment's. Null (not pinned) on localhost or with Turnstile's test secret,
 * whose passes report a dummy hostname of their own.
 */
function pinnedTurnstileHostname(env: AppEnv, hostname: string): string | null {
  return isLocalHost(hostname) || appConfig(env).auth.turnstileTestSecret ? null : hostname;
}

export function turnstileHostname(env: AppEnv, request: Request): string | null {
  return pinnedTurnstileHostname(env, new URL(authBaseUrl(env, request)).hostname);
}

export interface SocialProviderFlags {
  google: boolean;
  github: boolean;
}

export function socialProviderFlags(env: AppEnv): SocialProviderFlags {
  return {
    google: appConfig(env).auth.google !== null,
    github: appConfig(env).auth.github !== null,
  };
}

/** Only providers with both credentials are registered (and offered on the login page). */
function socialProviders(env: AppEnv): BetterAuthOptions['socialProviders'] {
  const { google, github } = appConfig(env).auth;
  return {
    ...(google ? { google: { ...google, prompt: 'select_account' as const } } : {}),
    ...(github ? { github: { ...github } } : {}),
  };
}

/**
 * Google and GitHub are used only to sign in: once Better Auth has read the
 * profile, nothing calls them on the user's behalf. So the tokens they issue
 * are never stored (a database copy would otherwise carry live credentials).
 * Better Auth has no option for this; `account` hooks null them on every
 * write: sign-up, linking (create) and the refresh on each later sign-in
 * (update). `encryptOAuthTokens` wouldn't do: it leaves the id_token in the
 * clear. If a feature ever needs the provider's API, drop this and enable
 * `account.encryptOAuthTokens`; tokens arrive at each user's next sign-in.
 * Better Auth's /get-access-token, /refresh-token and /account-info need the
 * stored tokens and so fail; the app doesn't use them.
 */
const NO_OAUTH_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
};

/**
 * Turnstile on first sign-in (see `createAuth`), while the open pool is
 * on. A magic link, and the code in the same email, was requested with a
 * Turnstile pass, as was an ID token sign-in: the user is recorded as
 * verified. An OAuth callback
 * of a user with no pass on record is redirected through the interstitial,
 * which continues to where the callback was going. Passkeys need a session to
 * be added, so they never sign a user in for the first time.
 */
async function recordFirstSignInCheck(
  env: AppEnv,
  origin: string,
  path: string | undefined,
  user: { id: string; email: string },
  headers: Headers | undefined,
): Promise<void> {
  // Only while the pool is on: it is what the record is for (pool/identity.ts).
  if (!appConfig(env).flags.poolEnabled) return;
  if (path === '/magic-link/verify' || isAppSignIn(path)) {
    await markPoolVerified(env.DB, user.id, user.email);
    return;
  }
  if (!path?.startsWith('/callback/') || !headers || !turnstileConfigured(env)) return;
  const location = headers.get('location');
  if (!location) return;
  const row = await env.DB.prepare('SELECT pool_verified_at FROM auth_users WHERE id = ?')
    .bind(user.id)
    .first<Pick<SqlRow<typeof authUsers>, 'pool_verified_at'>>();
  if (row?.pool_verified_at) return;
  // The callback's error redirects (`/login?error=…`) carry no session, so this is a sign-in.
  headers.set('location', verifyPageUrl(safeNextPath(location, origin)));
}

/**
 * Whether sign-ups are closed: the deployment has as many users as
 * `MAX_USERS` allows. Count-then-insert can let two simultaneous sign-ups
 * past the last seat; the cap is a soft limit, so that is fine.
 */
export async function signupsFull(env: AppEnv): Promise<boolean> {
  const max = appConfig(env).auth.maxUsers;
  if (max === null) return false;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_users').first<{ n: number }>();
  return (row?.n ?? 0) >= max;
}

async function userExists(env: AppEnv, email: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 FROM auth_users WHERE email = ?')
    .bind(email.toLowerCase())
    .first();
  return row !== null;
}

/**
 * Better Auth answers an APIError that has a code as JSON on the magic-link
 * request, and as a redirect to the login page with `?error=<code>` from the
 * OAuth callback and the magic-link verify.
 */
function signupsClosedError(): APIError {
  return new APIError('FORBIDDEN', {
    code: SIGNUPS_CLOSED,
    message: 'Tangent is not taking new accounts right now.',
  });
}

/** The value a pending `Set-Cookie` gives cookie `name`, decoded; undefined when there is none. */
function setCookieValue(headers: Headers | undefined, name: string): string | undefined {
  const cookie = headers?.getSetCookie().find((c) => c.startsWith(`${name}=`));
  if (cookie === undefined) return undefined;
  return decodeURIComponent(cookie.slice(name.length + 1).split(';')[0] ?? '');
}

/**
 * Better Auth's bearer plugin turns `Authorization: Bearer <token>` into the
 * session, on its own endpoints and on our `/api/*` (sessionMiddleware asks
 * Better Auth with the request's headers). Only signed tokens count, as only
 * signed cookies do: the raw token Better Auth puts in JSON bodies (e.g.
 * `get-session`) is no credential. The plugin's after hook, which would add
 * the token to every response that sets the session cookie, is left out so
 * the web apps' session stays out of reach of page scripts; the code sign-in
 * hands the token out instead (`createAuth`).
 */
function bearerSessions() {
  const plugin = bearer({ requireSignature: true });
  return { ...plugin, hooks: { before: plugin.hooks.before } };
}

/** Drops pending `Set-Cookie` entries for `name` so a re-issued cookie is the only one on the wire. */
function dropSetCookie(headers: Headers | undefined, name: string): void {
  if (!headers) return;
  const all = headers.getSetCookie();
  const keep = all.filter((c) => !c.startsWith(`${name}=`));
  if (keep.length === all.length) return;
  headers.delete('set-cookie');
  for (const c of keep) headers.append('set-cookie', c);
}

export function createAuth(env: AppEnv, baseUrl: string, deps: AuthDeps = {}) {
  const base = new URL(baseUrl);
  const turnstilePin = pinnedTurnstileHostname(env, base.hostname);
  const reviewer = appConfig(env).auth.reviewer;
  const isReviewer = (email: string) => email.toLowerCase() === reviewer?.email;

  const auth = betterAuth({
    appName: 'Tangent',
    baseURL: base.origin,
    basePath: AUTH_BASE_PATH,
    secret: appConfig(env).auth.secret ?? undefined,
    database: drizzleAdapter(drizzle(env.DB), {
      provider: 'sqlite',
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        passkey: authPasskeys,
        rateLimit: authRateLimits,
      },
    }),
    // No passwords, ever: email+password stays disabled (the default), so
    // sign-in is OAuth, magic link or passkey.
    emailAndPassword: { enabled: false },
    socialProviders: socialProviders(env),
    account: {
      // Signing in with Google, GitHub or a magic link lands on the same user,
      // but a provider identity is linked to an existing user only when the
      // provider reports the email verified (no `trustedProviders`: trusting
      // a provider skips that check, letting anyone whose provider account
      // claims the address unverified take over the user).
      accountLinking: { enabled: true },
    },
    session: {
      expiresIn: SESSION_DAYS * DAY_SECONDS,
      updateAge: DAY_SECONDS,
    },
    // In D1 so limits hold across isolates. Better Auth's defaults apply
    // (100 requests / 10 s per IP and path), plus the magic-link plugin's
    // own 5 / minute and the email-OTP plugin's 3 / minute on code sign-in.
    rateLimit: { enabled: true, storage: 'database' },
    disabledPaths: UNUSED_EMAIL_OTP_PATHS,
    advanced: {
      cookiePrefix: 'tangent',
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    databaseHooks: {
      user: {
        create: {
          // Covers every sign-up path (OAuth callback, magic link, code).
          // Anyone may sign up, but only with a verified email (the email's
          // link and code always are; OAuth reports it): the session
          // middleware refuses unverified users, so creating one would only
          // leave a user that can never get in. Returning false (rather than throwing) makes the OAuth
          // callback redirect to the login page with an error instead of
          // answering with JSON. The user cap is checked here too, so it
          // holds on every path; it throws for its own error code.
          before: async (user) => {
            if (!user.emailVerified) return false;
            if (await signupsFull(env)) throw signupsClosedError();
            return { data: user };
          },
          // A waitlisted address that signs up has what it waited for.
          after: async (user) => {
            await env.DB.prepare('DELETE FROM waitlist WHERE email = ?')
              .bind(user.email.toLowerCase())
              .run();
          },
        },
      },
      account: {
        create: { before: async (account) => ({ data: { ...account, ...NO_OAUTH_TOKENS } }) },
        update: { before: async (account) => ({ data: { ...account, ...NO_OAUTH_TOKENS } }) },
      },
    },
    hooks: {
      // The app's Google sign-in takes a Turnstile pass, as the sign-in
      // email does: the pool counts on one for every user (pool/identity.ts),
      // and the app has no browser to show the OAuth callback's interstitial.
      // The captcha plugin matches paths only, and the browser's redirect
      // start on this path has no captcha to give.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SOCIAL_SIGN_IN_PATH || !hasIdToken(ctx.body)) return;
        const pass = await verifyTurnstile(
          env,
          ctx.headers?.get('x-captcha-response') ?? '',
          ctx.headers?.get('cf-connecting-ip') ?? null,
          { hostname: turnstilePin },
        );
        if (!pass) {
          throw new APIError('BAD_REQUEST', {
            code: 'CAPTCHA_FAILED',
            message: 'Captcha verification failed',
          });
        }
      }),
      // "Remember me" for every sign-in method. Better Auth only has it for
      // email+password, so sessions are created remembered and, when the
      // login page asked otherwise, shortened here: 1 day server-side, a
      // browser-session cookie, and Better Auth's signed `dont_remember`
      // cookie so later refreshes don't extend it.
      //
      // A code is typed into the page or app that asked for it, so a
      // browser's code sign-in carries the login page's preference cookie.
      // A request without one (by code or ID token) is a client without
      // cookies (the phone app):
      // it keeps the token itself and has no browser session to end with,
      // so it gets the remembered session. A link, a callback or a passkey
      // without the cookie may be on a computer that never asked: those are
      // shortened.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-out') {
          // The user's provider keys go with their session (byok/keys.ts).
          ctx.setCookie(KEY_COOKIE_NAME, '', { ...KEY_COOKIE_ATTRIBUTES, maxAge: 0 });
          return;
        }
        if (!isSignInCompletion(ctx.path)) return;
        const created = ctx.context.newSession;
        if (!created) return;
        await recordFirstSignInCheck(
          env,
          base.origin,
          ctx.path,
          created.user,
          ctx.context.responseHeaders,
        );
        const preference = ctx.getCookie(REMEMBER_COOKIE);
        const remember = preference === '1' || (isAppSignIn(ctx.path) && preference === null);
        ctx.setCookie(REMEMBER_COOKIE, '', { path: AUTH_BASE_PATH, maxAge: 0 });
        const sessionCookie = ctx.context.authCookies.sessionToken.name;
        // Only the app's sign-ins hand out the token: they take the emailed
        // code or an ID token Google issued after the user picked an
        // account, which a script on a page lacks. The signed value is the
        // session cookie's, which a shortened session keeps.
        if (isAppSignIn(ctx.path)) {
          const token = setCookieValue(ctx.context.responseHeaders, sessionCookie);
          if (token) ctx.setHeader(BEARER_TOKEN_HEADER, token);
        }
        if (remember) return;
        const expiresAt = new Date(Date.now() + DAY_SECONDS * 1000);
        await ctx.context.internalAdapter.updateSession(created.session.token, { expiresAt });
        dropSetCookie(ctx.context.responseHeaders, sessionCookie);
        await setSessionCookie(
          ctx,
          { session: { ...created.session, expiresAt }, user: created.user },
          true,
        );
      }),
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_MINUTES * 60,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          // A new address is refused before its link is sent, so nobody waits
          // for an email that can only fail; the user hook still refuses a
          // link sent while there was room. Checked here, after the captcha,
          // so whether an address has an account can't be probed without one.
          if (!(await userExists(env, email)) && (await signupsFull(env)))
            throw signupsClosedError();
          // The code goes in the same email, so this captcha-gated request is
          // the only way to get one.
          const code = await auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } });
          // The reviewer's code is fixed and their inbox unread: no email.
          if (isReviewer(email)) return;
          const sender = deps.emailSender ?? createEmailSender(env, base.origin);
          await sender.send(magicLinkEmail(email, url, code, MAGIC_LINK_MINUTES));
        },
      }),
      // Sign-in by the code in the magic-link email (`POST
      // /api/auth/sign-in/email-otp {email, otp}`), for where the link can't
      // reach: the phone app, or a computer the email isn't open on. It signs
      // up a new address as the link does. The code is 6 digits from the
      // CSPRNG; 3 wrong tries end it, so guessing has 3 chances in a million
      // per email, and each email takes a captcha. It is stored encrypted
      // with BETTER_AUTH_SECRET: a hash of a 6-digit number is reversed by
      // trying them all.
      emailOTP({
        otpLength: SIGN_IN_CODE_LENGTH,
        expiresIn: MAGIC_LINK_MINUTES * 60,
        allowedAttempts: 3,
        storeOTP: 'encrypted',
        // The app-store reviewer (REVIEWER_SIGN_IN) always gets the same
        // code, so their credentials can be written down and reused; undefined
        // keeps the random code for everyone else. Guessing it still takes a
        // captcha per 3 tries, and the email is a secret too.
        generateOTP: ({ email }) => (isReviewer(email) ? reviewer?.code : undefined),
        // Never called: the endpoints that would send a code on their own are
        // disabled (UNUSED_EMAIL_OTP_PATHS) and codes go out in the magic-link
        // email. It fails closed should that ever change.
        sendVerificationOTP: () =>
          Promise.reject(new Error('Sign-in codes are sent only with the magic link')),
      }),
      bearerSessions(),
      passkey({
        rpID: base.hostname,
        rpName: 'Tangent',
        origin: base.origin,
      }),
      // Only the endpoint that sends email needs a captcha here (the app's
      // ID token sign-in has its own, in `hooks.before`): OAuth providers
      // run their own bot checks and passkeys can't be scripted. With no
      // TURNSTILE_SECRET_KEY the plugin rejects the request (fails closed).
      captcha({
        provider: 'cloudflare-turnstile',
        secretKey: appConfig(env).auth.turnstileSecretKey ?? '',
        endpoints: ['/sign-in/magic-link'],
        ...(turnstilePin === null ? {} : { allowedHostnames: [turnstilePin] }),
      }),
    ],
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

// One instance per env object and origin per isolate: setting Better Auth up
// isn't free, and the env object is stable for the isolate's lifetime.
const instances = new WeakMap<AppEnv, Map<string, Auth>>();

export function getAuth(env: AppEnv, request: Request, deps: AuthDeps = {}): Auth {
  const baseUrl = authBaseUrl(env, request);
  if (deps.emailSender) return createAuth(env, baseUrl, deps);
  let byOrigin = instances.get(env);
  if (!byOrigin) {
    byOrigin = new Map();
    instances.set(env, byOrigin);
  }
  let auth = byOrigin.get(baseUrl);
  if (!auth) {
    auth = createAuth(env, baseUrl, deps);
    byOrigin.set(baseUrl, auth);
  }
  return auth;
}
