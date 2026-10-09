import { passkey } from '@better-auth/passkey';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { captcha } from 'better-auth/plugins';
import { magicLink } from 'better-auth/plugins/magic-link';
import { drizzle } from 'drizzle-orm/d1';
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
import type { AppEnv } from '../env.js';
import { markPoolVerified } from '../pool/identity.js';
import { safeNextPath, turnstileConfigured, verifyPageUrl } from '../pool/turnstile.js';

/**
 * Better Auth (https://better-auth.com), mounted at `/api/auth/*`.
 *
 * Sign-in methods: Google, GitHub, magic link (email) and passkeys. There are
 * no passwords: the email+password method is never enabled. Passkeys are
 * added from the account dialog once signed in, then work as a sign-in method.
 *
 * Anyone may sign up; abuse is bounded by Turnstile and the rate limits on
 * magic links. While the open pool is on, Turnstile runs on every first
 * sign-in: a magic link can only be requested with
 * a Turnstile pass, so signing in with one records it
 * (`auth_users.pool_verified_at`); a first OAuth sign-in (or any OAuth
 * sign-in of a user with no pass on record) is sent through the Turnstile
 * interstitial (http/verify-page.ts) on its way to the app. A user needs a
 * verified email (OAuth providers report it, a magic link proves it):
 * unverified users are never created. Each user gets
 * their own accounts (auth/account.ts). Power mode is bring-your-own-key for
 * every signed-in user: the server's provider keys serve only the local dev bypass.
 *
 * Payments don't go through Better Auth: the membership, top-ups and the
 * payment provider's webhooks are billing routes (billing/payments).
 */

export const AUTH_BASE_PATH = '/api/auth';

/**
 * Set by the login page right before a sign-in starts: `1` = remember me
 * (a persistent session cookie), anything else = a browser-session cookie.
 * It's a plain preference cookie because the OAuth callback and the magic
 * link arrive as top-level navigations that can't carry a request body.
 */
export const REMEMBER_COOKIE = 'tangent-remember';

const DAY_SECONDS = 24 * 60 * 60;
/** Remembered sessions: 30 days, extended by activity (at most once a day). */
const SESSION_DAYS = 30;
export const MAGIC_LINK_MINUTES = 15;

/** Endpoints that finish a sign-in (and create the session). */
function isSignInCompletion(path: string | undefined): boolean {
  return (
    path === '/magic-link/verify' ||
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
 * The hostname a Turnstile token must have been issued for: this deployment's.
 * Null (not pinned) on localhost, as Turnstile's test keys report their own.
 */
export function turnstileHostname(env: AppEnv, request: Request): string | null {
  const hostname = new URL(authBaseUrl(env, request)).hostname;
  return isLocalHost(hostname) ? null : hostname;
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
 * on. A magic link was requested with a Turnstile pass: the user is recorded
 * as verified. An OAuth callback
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
  if (path === '/magic-link/verify') {
    await markPoolVerified(env.DB, user.id, user.email);
    return;
  }
  if (!path?.startsWith('/callback/') || !headers || !turnstileConfigured(env)) return;
  const location = headers.get('location');
  if (!location) return;
  const row = await env.DB.prepare('SELECT pool_verified_at FROM auth_users WHERE id = ?')
    .bind(user.id)
    .first<{ pool_verified_at: string | null }>();
  if (row?.pool_verified_at) return;
  // The callback's error redirects (`/login?error=…`) carry no session, so this is a sign-in.
  headers.set('location', verifyPageUrl(safeNextPath(location, origin)));
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
  const local = isLocalHost(base.hostname);

  return betterAuth({
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
    // own 5 / minute.
    rateLimit: { enabled: true, storage: 'database' },
    advanced: {
      cookiePrefix: 'tangent',
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    databaseHooks: {
      user: {
        create: {
          // Covers every sign-up path (OAuth callback, magic link). Anyone may
          // sign up, but only with a verified email (magic links always are;
          // OAuth reports it): the session middleware refuses unverified
          // users, so creating one would only leave a user that can never get
          // in. Returning false (rather than throwing) makes the OAuth
          // callback redirect to the login page with an error instead of
          // answering with JSON.
          before: async (user) => (user.emailVerified ? { data: user } : false),
        },
      },
      account: {
        create: { before: async (account) => ({ data: { ...account, ...NO_OAUTH_TOKENS } }) },
        update: { before: async (account) => ({ data: { ...account, ...NO_OAUTH_TOKENS } }) },
      },
    },
    hooks: {
      // "Remember me" for every sign-in method. Better Auth only has it for
      // email+password, so sessions are created remembered and, when the
      // login page asked otherwise, shortened here: 1 day server-side, a
      // browser-session cookie, and Better Auth's signed `dont_remember`
      // cookie so later refreshes don't extend it.
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
        const remember = ctx.getCookie(REMEMBER_COOKIE) === '1';
        ctx.setCookie(REMEMBER_COOKIE, '', { path: AUTH_BASE_PATH, maxAge: 0 });
        if (remember) return;
        const expiresAt = new Date(Date.now() + DAY_SECONDS * 1000);
        await ctx.context.internalAdapter.updateSession(created.session.token, { expiresAt });
        dropSetCookie(ctx.context.responseHeaders, ctx.context.authCookies.sessionToken.name);
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
          const sender = deps.emailSender ?? createEmailSender(env, base.origin);
          await sender.send(magicLinkEmail(email, url, MAGIC_LINK_MINUTES));
        },
      }),
      passkey({
        rpID: base.hostname,
        rpName: 'Tangent',
        origin: base.origin,
      }),
      // Only the endpoint that sends email needs a captcha: OAuth providers
      // run their own bot checks and passkeys can't be scripted. With no
      // TURNSTILE_SECRET_KEY the plugin rejects the request (fails closed).
      captcha({
        provider: 'cloudflare-turnstile',
        secretKey: appConfig(env).auth.turnstileSecretKey ?? '',
        endpoints: ['/sign-in/magic-link'],
        // Turnstile's test keys report their own hostname, so only pin it in deployments.
        ...(local ? {} : { allowedHostnames: [base.hostname] }),
      }),
    ],
  });
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
