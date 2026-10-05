import { passkey } from '@better-auth/passkey';
import { stripe } from '@better-auth/stripe';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { captcha } from 'better-auth/plugins';
import { magicLink } from 'better-auth/plugins/magic-link';
import { MEMBERSHIP_PLAN } from '@tangent/shared';
import { drizzle } from 'drizzle-orm/d1';
import {
  authAccounts,
  authPasskeys,
  authRateLimits,
  authSessions,
  authSubscriptions,
  authUsers,
  authVerifications,
} from '../db/schema.js';
import { billingConfigured, getStripe, membershipPriceId } from '../billing/stripe.js';
import { handleStripeEvent } from '../billing/webhook.js';
import { createEmailSender, magicLinkEmail, type EmailSender } from '../email/index.js';
import type { AppEnv } from '../env.js';

/**
 * Better Auth (https://better-auth.com), mounted at `/api/auth/*`.
 *
 * Sign-in methods: Google, GitHub, magic link (email) and passkeys. There are
 * no passwords: the email+password method is never enabled. Passkeys are
 * added from the account dialog once signed in, then work as a sign-in method.
 *
 * Anyone may sign up; abuse is bounded by Turnstile and the rate limits on
 * magic links. A user needs a verified email (OAuth providers report it, a
 * magic link proves it): unverified users are never created. Each user gets
 * their own accounts (auth/account.ts). Power mode is bring-your-own-key for
 * every signed-in user: the server's provider keys serve only the local dev bypass.
 *
 * When Stripe is configured (billing/stripe.ts) the Better Auth Stripe plugin
 * adds the membership endpoints (`/api/auth/subscription/*`) and the one
 * Stripe webhook, `/api/auth/stripe/webhook`, whose events also reach our
 * ledger through `onEvent` (billing/webhook.ts).
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
  return !!env.BETTER_AUTH_SECRET?.trim();
}

/** PUBLIC_BASE_URL, or the request's origin when it's unset (local dev and tests). */
export function authBaseUrl(env: AppEnv, request: Request): string {
  const configured = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  return configured || new URL(request.url).origin;
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function oauthApp(id: string | undefined, secret: string | undefined) {
  const clientId = id?.trim();
  const clientSecret = secret?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export interface SocialProviderFlags {
  google: boolean;
  github: boolean;
}

export function socialProviderFlags(env: AppEnv): SocialProviderFlags {
  return {
    google: !!oauthApp(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    github: !!oauthApp(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
  };
}

/** Only providers with both credentials are registered (and offered on the login page). */
function socialProviders(env: AppEnv): BetterAuthOptions['socialProviders'] {
  const google = oauthApp(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  const github = oauthApp(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET);
  return {
    ...(google ? { google: { ...google, prompt: 'select_account' as const } } : {}),
    ...(github ? { github } : {}),
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
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.DB), {
      provider: 'sqlite',
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        passkey: authPasskeys,
        rateLimit: authRateLimits,
        // The Stripe plugin's table; mapped even when billing is off so the
        // schema doesn't depend on configuration.
        subscription: authSubscriptions,
      },
    }),
    // No passwords, ever: email+password stays disabled (the default), so
    // sign-in is OAuth, magic link or passkey.
    emailAndPassword: { enabled: false },
    socialProviders: socialProviders(env),
    account: {
      // Google and GitHub both verify the email, so signing in with either
      // (or a magic link) lands on the same user.
      accountLinking: { enabled: true, trustedProviders: ['google', 'github'] },
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
        if (!isSignInCompletion(ctx.path)) return;
        const created = ctx.context.newSession;
        if (!created) return;
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
        secretKey: env.TURNSTILE_SECRET_KEY?.trim() ?? '',
        endpoints: ['/sign-in/magic-link'],
        // Turnstile's test keys report their own hostname, so only pin it in deployments.
        ...(local ? {} : { allowedHostnames: [base.hostname] }),
      }),
      ...stripePlugin(env),
    ],
  });
}

/**
 * The Better Auth Stripe plugin, only when billing is configured (PLAN §2.3).
 * Customers are created lazily (first checkout). Its one plan is the yearly
 * membership (`MEMBERSHIP_PLAN`, STRIPE_MEMBERSHIP_PRICE_ID; none while that
 * is unset): the plugin holds one subscription per user, so there is room for
 * nothing else. Every webhook event is passed on to our ledger. Throwing from
 * `onEvent` makes the plugin answer 400, so Stripe retries.
 */
function stripePlugin(env: AppEnv) {
  const client = billingConfigured(env) ? getStripe(env) : null;
  if (!client) return [];
  return [
    stripe({
      stripeClient: client,
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() ?? '',
      createCustomerOnSignUp: false,
      onEvent: (event) => handleStripeEvent(env, event),
      subscription: {
        enabled: true,
        requireEmailVerification: true,
        plans: membershipPlans(env),
        // Stripe Tax on exclusive prices; tax never enters our ledger.
        getCheckoutSessionParams: () => ({
          params: {
            automatic_tax: { enabled: true },
            billing_address_collection: 'required' as const,
            tax_id_collection: { enabled: true },
          },
        }),
      },
    }),
  ];
}

function membershipPlans(env: AppEnv) {
  const priceId = membershipPriceId(env);
  if (!priceId) return [];
  // One plan, so there is nothing to switch to and nothing to prorate.
  return [{ name: MEMBERSHIP_PLAN, priceId, prorationBehavior: 'none' as const }];
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
