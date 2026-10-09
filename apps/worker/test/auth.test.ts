import type { LoginOptionsResponse, MeResponse } from '@tangent/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { REMEMBER_COOKIE } from '../src/auth/auth.js';
import type { EmailMessage, EmailSender } from '../src/email/index.js';
import type { AppEnv } from '../src/env.js';
import { BASE } from './http.js';

const SESSION_COOKIE = '__Secure-tangent.session_token';
const DONT_REMEMBER_COOKIE = '__Secure-tangent.dont_remember';

class CapturingSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** Auth configured the way production is (tests' default env runs in dev-bypass mode). */
function authEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ...env,
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_SITE_KEY: 'site-key',
    DEV_ALLOW_NO_AUTH: 'true',
    ...overrides,
  } as AppEnv;
}

let ipSeq = 0;

/**
 * Each setup() is a distinct client IP: Better Auth's rate limits (in D1) are
 * per IP, and the magic-link endpoint allows only 5 requests a minute.
 */
function setup(e: AppEnv = authEnv()) {
  const mail = new CapturingSender();
  const app = createApp({ auth: { emailSender: mail } });
  const ip = `203.0.113.${++ipSeq}`;
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cf-connecting-ip', ip);
    return app.request(`${BASE}${path}`, { ...init, headers }, e);
  };
  return { app, mail, call, env: e };
}

/** `name=value` pairs from a response's Set-Cookie headers, for the next request's Cookie header. */
function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

function findSetCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

async function requestMagicLink(
  call: ReturnType<typeof setup>['call'],
  email: string,
  captcha: string | null = 'pass',
): Promise<Response> {
  return call('/api/auth/sign-in/magic-link', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: BASE,
      ...(captcha === null ? {} : { 'x-captcha-response': captcha }),
    },
    body: JSON.stringify({ email, callbackURL: '/', errorCallbackURL: '/login' }),
  });
}

function linkFrom(message: EmailMessage): string {
  const m = /https?:\/\/\S+/.exec(message.text);
  if (!m) throw new Error('no link in email');
  return m[0];
}

/** Full magic-link sign-in; returns the verify response (redirect + cookies). */
async function signIn(
  s: ReturnType<typeof setup>,
  email = 'owner@example.com',
  remember = true,
): Promise<Response> {
  const res = await requestMagicLink(s.call, email);
  expect(res.status).toBe(200);
  const link = new URL(linkFrom(s.mail.sent.at(-1)!));
  return s.call(link.pathname + link.search, {
    headers: remember ? { cookie: `${REMEMBER_COOKIE}=1` } : {},
    redirect: 'manual',
  });
}

describe('fail closed', () => {
  it('500 on /api/* and /api/auth/* with no BETTER_AUTH_SECRET and no dev bypass', async () => {
    for (const dev of ['', 'false']) {
      const { call } = setup(authEnv({ BETTER_AUTH_SECRET: '', DEV_ALLOW_NO_AUTH: dev }));
      const me = await call('/api/me');
      expect(me.status).toBe(500);
      expect(await me.json()).toEqual({
        error: { code: 'internal', message: 'Authentication is not configured' },
      });
      expect((await call('/api/auth/get-session')).status).toBe(500);
    }
    // A near miss is a config error, never the bypass.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const dev of ['1', 'TRUE', ' true']) {
      const { call } = setup(authEnv({ BETTER_AUTH_SECRET: '', DEV_ALLOW_NO_AUTH: dev }));
      const me = await call('/api/me');
      expect(me.status).toBe(500);
      expect(((await me.json()) as { error: { code: string } }).error.code).toBe('internal');
    }
    error.mockRestore();
  });

  it('dev bypass applies only while BETTER_AUTH_SECRET is unset', async () => {
    const dev = setup(authEnv({ BETTER_AUTH_SECRET: '' }));
    expect(await (await dev.call('/api/me')).json()).toEqual({
      email: null,
      userId: null,
      devMode: true,
      accountId: 'default',
      mode: 'power',
      operatorKeys: true,
      builtInCredit: true,
      sharing: true,
      isAdmin: true,
      membership: {
        required: false,
        status: 'inactive',
        subscriptionStatus: null,
        periodEnd: null,
        cancelAtPeriodEnd: false,
        priceCents: 1000,
      },
      // The dev bypass requires no membership: nothing is ever read-only.
      membershipNeededFor: [],
    } satisfies MeResponse);

    // Secret set: DEV_ALLOW_NO_AUTH=true is ignored and a session is required.
    const { call } = setup();
    expect((await call('/api/me')).status).toBe(401);
  });

  it('unknown /api routes still require a session; after sign-in they 404 as ApiError', async () => {
    const s = setup();
    expect((await s.call('/api/nope')).status).toBe(401);
    const cookie = cookieHeader(await signIn(s));
    const res = await s.call('/api/nope', { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('the deployed entrypoint serves /api/me in dev-bypass mode (test config)', async () => {
    const res = await exports.default.fetch(`${BASE}/api/me`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: null,
      userId: null,
      devMode: true,
      accountId: 'default',
      mode: 'power',
      operatorKeys: true,
      builtInCredit: true,
      sharing: true,
      isAdmin: true,
      membership: {
        required: false,
        status: 'inactive',
        subscriptionStatus: null,
        periodEnd: null,
        cancelAtPeriodEnd: false,
        priceCents: 1000,
      },
      membershipNeededFor: [],
    } satisfies MeResponse);
  });
});

describe('login options', () => {
  it('reports configured providers and the Turnstile site key', async () => {
    const { call } = setup(
      authEnv({
        GOOGLE_CLIENT_ID: 'gid',
        GOOGLE_CLIENT_SECRET: 'gsecret',
        GITHUB_CLIENT_ID: 'only-id',
      }),
    );
    const res = await call('/api/login-options');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: true,
      devMode: false,
      social: { google: true, github: false },
      turnstileSiteKey: 'site-key',
    } satisfies LoginOptionsResponse);
  });

  it('is public, and says so when auth is not configured', async () => {
    const { call } = setup(authEnv({ BETTER_AUTH_SECRET: '', TURNSTILE_SITE_KEY: '' }));
    expect(await (await call('/api/login-options')).json()).toEqual({
      configured: false,
      devMode: true,
      social: { google: false, github: false },
      turnstileSiteKey: null,
    } satisfies LoginOptionsResponse);
  });
});

describe('magic link', () => {
  it('is rate limited per IP', async () => {
    const s = setup();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await requestMagicLink(s.call, 'owner@example.com')).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('requires a valid captcha', async () => {
    const s = setup();
    expect((await requestMagicLink(s.call, 'owner@example.com', null)).status).toBe(400);
    expect((await requestMagicLink(s.call, 'owner@example.com', 'fail')).status).toBe(403);
    expect(s.mail.sent).toHaveLength(0);
  });

  it('fails closed without TURNSTILE_SECRET_KEY', async () => {
    const s = setup(authEnv({ TURNSTILE_SECRET_KEY: '' }));
    expect((await requestMagicLink(s.call, 'owner@example.com')).status).toBe(500);
    expect(s.mail.sent).toHaveLength(0);
  });

  it('signs in any email: link → session cookie → /api/me', async () => {
    const s = setup();
    const res = await signIn(s);
    expect(s.mail.sent).toHaveLength(1);
    expect(s.mail.sent[0]).toMatchObject({
      to: 'owner@example.com',
      subject: 'Sign in to Tangent',
    });
    expect(s.mail.sent[0]!.html).toContain('/api/auth/magic-link/verify');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/`);
    const me = await s.call('/api/me', { headers: { cookie: cookieHeader(res) } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as MeResponse;
    expect(body).toMatchObject({
      email: 'owner@example.com',
      devMode: false,
      mode: 'power',
      operatorKeys: false,
      isAdmin: false,
    });
    expect(body.accountId).toMatch(/^p_.+/);
    expect(body.userId).toBe(body.accountId.slice('p_'.length));
  });

  it('a link works once', async () => {
    const s = setup();
    await signIn(s);
    const link = new URL(linkFrom(s.mail.sent[0]!));
    const again = await s.call(link.pathname + link.search, { redirect: 'manual' });
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toBe(`${BASE}/login?error=INVALID_TOKEN`);
    expect(findSetCookie(again, SESSION_COOKIE)).toBeUndefined();
  });

  it('signs up a stranger, who gets their own account without server keys', async () => {
    const s = setup();
    const cookie = cookieHeader(await signIn(s, 'stranger@example.com'));
    expect(s.mail.sent).toHaveLength(1);
    const me = (await (await s.call('/api/me', { headers: { cookie } })).json()) as MeResponse;
    expect(me).toMatchObject({ email: 'stranger@example.com', mode: 'power', operatorKeys: false });
    expect(me.accountId).toMatch(/^p_.+/);
  });

  it('a user whose email is no longer verified is refused, whatever sessions they hold', async () => {
    const s = setup();
    const cookie = cookieHeader(await signIn(s, 'member@example.org'));
    expect((await s.call('/api/me', { headers: { cookie } })).status).toBe(200);
    await env.DB.prepare('UPDATE auth_users SET email_verified = 0 WHERE email = ?')
      .bind('member@example.org')
      .run();
    const res = await s.call('/api/me', { headers: { cookie } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } });
  });
});

describe('remember me', () => {
  async function sessionExpiry(res: Response): Promise<number> {
    const token = decodeURIComponent(
      findSetCookie(res, SESSION_COOKIE)!.split(';')[0]!.split('=')[1]!,
    ).split('.')[0]!;
    const row = await env.DB.prepare('SELECT expires_at FROM auth_sessions WHERE token = ?')
      .bind(token)
      .first<{
        expires_at: number;
      }>();
    return row!.expires_at - Date.now();
  }
  const DAY = 24 * 60 * 60 * 1000;

  it('remembered: a persistent 30-day cookie and session', async () => {
    const res = await signIn(setup(), 'owner@example.com', true);
    const cookie = findSetCookie(res, SESSION_COOKIE)!;
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(findSetCookie(res, DONT_REMEMBER_COOKIE)).toBeUndefined();
    expect(await sessionExpiry(res)).toBeGreaterThan(29 * DAY);
    // The one-shot preference cookie is cleared.
    expect(findSetCookie(res, REMEMBER_COOKIE)).toMatch(/Max-Age=0/);
  });

  it('not remembered: a browser-session cookie, a 1-day session, and only one session cookie', async () => {
    const res = await signIn(setup(), 'owner@example.com', false);
    const sessionCookies = res.headers
      .getSetCookie()
      .filter((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(sessionCookies).toHaveLength(1);
    expect(sessionCookies[0]).not.toMatch(/Max-Age/i);
    expect(sessionCookies[0]).not.toMatch(/Expires/i);
    expect(findSetCookie(res, DONT_REMEMBER_COOKIE)).toBeDefined();
    const left = await sessionExpiry(res);
    expect(left).toBeLessThanOrEqual(DAY);
    expect(left).toBeGreaterThan(DAY - 60_000);
  });

  it('a non-remembered session still works for the API', async () => {
    const s = setup();
    const cookie = cookieHeader(await signIn(s, 'owner@example.com', false));
    expect((await s.call('/api/me', { headers: { cookie } })).status).toBe(200);
  });
});

describe('social sign-in', () => {
  it('redirects to Google when it is configured', async () => {
    const { call } = setup(authEnv({ GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' }));
    const res = await call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ provider: 'google', callbackURL: '/', errorCallbackURL: '/login' }),
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const target = new URL(url);
    expect(target.hostname).toBe('accounts.google.com');
    expect(target.searchParams.get('client_id')).toBe('gid');
    expect(target.searchParams.get('redirect_uri')).toBe(`${BASE}/api/auth/callback/google`);
  });

  /** Starts a Google sign-in and comes back through the callback as `email`. */
  async function googleSignIn(s: ReturnType<typeof setup>, email: string, remember: boolean) {
    const start = await s.call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ provider: 'google', callbackURL: '/', errorCallbackURL: '/login' }),
    });
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')!;
    const cookies = [cookieHeader(start), remember ? `${REMEMBER_COOKIE}=1` : '']
      .filter(Boolean)
      .join('; ');
    return s.call(
      `/api/auth/callback/google?code=${encodeURIComponent(email)}&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: cookies },
        redirect: 'manual',
      },
    );
  }
  /** Google configured; the pool (and so the first-sign-in interstitial) off unless overridden. */
  const googleEnv = (overrides: Partial<AppEnv> = {}) =>
    authEnv({
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: 'gsecret',
      POOL_ENABLED: 'false',
      ...overrides,
    });

  it('the callback signs in a Google account, honouring remember me', async () => {
    const s = setup(googleEnv());
    const res = await googleSignIn(s, 'owner@example.com', false);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const session = res.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(session).toHaveLength(1);
    expect(session[0]).not.toMatch(/Max-Age/i);
    expect(findSetCookie(res, DONT_REMEMBER_COOKIE)).toBeDefined();
    const me = await s.call('/api/me', { headers: { cookie: cookieHeader(res) } });
    expect(await me.json()).toMatchObject({ email: 'owner@example.com' });

    const remembered = await googleSignIn(setup(googleEnv()), 'owner@example.com', true);
    expect(findSetCookie(remembered, SESSION_COOKIE)).toMatch(/Max-Age=2592000/);
  });

  it('creates a verified Google user but refuses an unverified one', async () => {
    const s = setup(googleEnv());
    const ok = await googleSignIn(s, 'learner@example.org', true);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/');
    const me = await s.call('/api/me', {
      headers: { cookie: cookieHeader(ok), 'x-tangent-mode': 'simple' },
    });
    expect(await me.json()).toMatchObject({ email: 'learner@example.org', mode: 'simple' });

    // An unverified user would be refused by the session check forever: never created.
    const res = await googleSignIn(setup(googleEnv()), 'unverified-learner@example.org', true);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?error=unable_to_create_user');
    expect(findSetCookie(res, SESSION_COOKIE)).toBeUndefined();
    const row = await env.DB.prepare('SELECT id FROM auth_users WHERE email = ?')
      .bind('unverified-learner@example.org')
      .first();
    expect(row).toBeNull();
  });

  it('links Google to an existing user only when Google verified the email', async () => {
    const googleAccounts = (email: string) =>
      env.DB.prepare(
        `SELECT a.account_id FROM auth_accounts a JOIN auth_users u ON u.id = a.user_id
          WHERE u.email = ? AND a.provider_id = 'google'`,
      )
        .bind(email)
        .all();
    const userIdOf = async (res: Response, s: ReturnType<typeof setup>) => {
      const me = await s.call('/api/me', { headers: { cookie: cookieHeader(res) } });
      return ((await me.json()) as MeResponse).userId;
    };

    // The mock reports email_verified: false for an address starting with `unverified`.
    const victim = 'unverified-victim@example.org';
    const owner = setup(googleEnv());
    const ownerId = await userIdOf(await signIn(owner, victim), owner);
    const takeover = await googleSignIn(setup(googleEnv()), victim, true);
    expect(takeover.status).toBe(302);
    expect(takeover.headers.get('location')).toMatch(/^\/login\?error=/);
    expect(findSetCookie(takeover, SESSION_COOKIE)).toBeUndefined();
    expect((await googleAccounts(victim)).results).toHaveLength(0);

    const linked = 'linked@example.org';
    const magic = setup(googleEnv());
    const linkedId = await userIdOf(await signIn(magic, linked), magic);
    const s = setup(googleEnv());
    const res = await googleSignIn(s, linked, true);
    expect(res.headers.get('location')).toBe('/');
    expect(await userIdOf(res, s)).toBe(linkedId);
    expect((await googleAccounts(linked)).results).toHaveLength(1);
    expect(ownerId).not.toBe(linkedId);
  });

  it('keeps the Google account id but none of its tokens, on sign-up or later sign-ins', async () => {
    const email = 'tokens@example.org';
    const stored = () =>
      env.DB.prepare(
        `SELECT a.account_id, a.access_token, a.refresh_token, a.id_token,
                a.access_token_expires_at, a.refresh_token_expires_at
           FROM auth_accounts a JOIN auth_users u ON u.id = a.user_id
          WHERE u.email = ? AND a.provider_id = 'google'`,
      )
        .bind(email)
        .first();
    const noTokens = {
      account_id: `google-${email}`,
      access_token: null,
      refresh_token: null,
      id_token: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
    };

    expect((await googleSignIn(setup(googleEnv()), email, true)).status).toBe(302);
    expect(await stored()).toEqual(noTokens);
    // A returning user goes through the update path (Better Auth refreshes tokens there).
    expect((await googleSignIn(setup(googleEnv()), email, true)).status).toBe(302);
    expect(await stored()).toEqual(noTokens);
  });

  it('refuses a provider that is not configured', async () => {
    const { call } = setup();
    const res = await call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ provider: 'github', callbackURL: '/' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('Turnstile on first sign-in', () => {
  const poolOn = () =>
    authEnv({ GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', POOL_ENABLED: 'true' });

  async function googleSignIn(s: ReturnType<typeof setup>, email: string) {
    const start = await s.call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({
        provider: 'google',
        callbackURL: '/learn/',
        errorCallbackURL: '/login',
      }),
    });
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')!;
    return s.call(
      `/api/auth/callback/google?code=${encodeURIComponent(email)}&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `${cookieHeader(start)}; ${REMEMBER_COOKIE}=1` }, redirect: 'manual' },
    );
  }

  function verified(email: string) {
    return env.DB.prepare('SELECT pool_verified_at, pool_identity FROM auth_users WHERE email = ?')
      .bind(email)
      .first<{ pool_verified_at: string | null; pool_identity: string | null }>();
  }

  function postVerify(
    s: ReturnType<typeof setup>,
    cookie: string,
    token: string,
    next = '/learn/',
  ) {
    return s.call('/verify', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE,
        'sec-fetch-site': 'same-origin',
      },
      body: new URLSearchParams({ next, 'cf-turnstile-response': token }).toString(),
      redirect: 'manual',
    });
  }

  it('a magic-link sign-in records the Turnstile pass its request needed', async () => {
    const s = setup(poolOn());
    await signIn(s, 'magic-verified@example.org');
    const row = await verified('magic-verified@example.org');
    expect(row?.pool_verified_at).toBeTruthy();
    expect(row?.pool_identity).toMatch(/^[0-9a-f]{64}$/);
    // Signing in with Google later needs no second check.
    const res = await googleSignIn(setup(poolOn()), 'magic-verified@example.org');
    expect(res.headers.get('location')).toBe('/learn/');
  });

  it('a first Google sign-in passes through the interstitial, which records the pass', async () => {
    const s = setup(poolOn());
    const email = 'oauth-first@example.org';
    const res = await googleSignIn(s, email);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/verify?next=%2Flearn%2F');
    expect(findSetCookie(res, SESSION_COOKIE)).toBeDefined();
    expect((await verified(email))?.pool_verified_at).toBeNull();
    const cookie = cookieHeader(res);

    const page = await s.call('/verify?next=%2Flearn%2F', { headers: { cookie } });
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain('script-src https://challenges.cloudflare.com');
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    expect(csp).toContain("form-action 'self'");
    const html = await page.text();
    // The one inline stylesheet is the one the CSP allows by hash.
    const style = /<style>([^]*?)<\/style>/.exec(html)![1]!;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(style));
    expect(csp).toContain(
      `style-src 'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`,
    );
    expect(html).toContain(
      'class="cf-turnstile" data-sitekey="site-key" data-action="pool-verify"',
    );
    expect(html).toContain('name="next" value="/learn/"');
    expect(html).not.toMatch(/donat|tax[- ]?deductible/i);

    const failed = await postVerify(s, cookie, 'not-a-pass');
    expect(failed.status).toBe(400);
    expect(await failed.text()).toContain('role="alert"');
    expect((await verified(email))?.pool_verified_at).toBeNull();

    const passed = await postVerify(s, cookie, 'pass');
    expect(passed.status).toBe(303);
    expect(passed.headers.get('location')).toBe('/learn/');
    const row = await verified(email);
    expect(row?.pool_verified_at).toBeTruthy();
    expect(row?.pool_identity).toMatch(/^[0-9a-f]{64}$/);

    // Verified: the page just continues, and the next Google sign-in goes straight to the app.
    const again = await s.call('/verify?next=%2Flearn%2F', {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe('/learn/');
    expect((await googleSignIn(setup(poolOn()), email)).headers.get('location')).toBe('/learn/');
  });

  it('no interstitial while the pool is off or Turnstile is not configured', async () => {
    const off = await googleSignIn(
      setup(
        authEnv({
          GOOGLE_CLIENT_ID: 'gid',
          GOOGLE_CLIENT_SECRET: 'gsecret',
          POOL_ENABLED: 'false',
        }),
      ),
      'oauth-pool-off@example.org',
    );
    expect(off.headers.get('location')).toBe('/learn/');
    const noKey = await googleSignIn(
      setup(
        authEnv({
          GOOGLE_CLIENT_ID: 'gid',
          GOOGLE_CLIENT_SECRET: 'gsecret',
          POOL_ENABLED: 'true',
          TURNSTILE_SITE_KEY: '',
        }),
      ),
      'oauth-no-turnstile@example.org',
    );
    expect(noKey.headers.get('location')).toBe('/learn/');
  });

  it('continues only to same-origin paths, and only for a signed-in user', async () => {
    const s = setup(poolOn());
    const signedOut = await s.call('/verify?next=%2Flearn%2F', { redirect: 'manual' });
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get('location')).toBe('/learn/');
    for (const next of ['//evil.example/x', 'https://evil.example/', '/\\evil.example']) {
      const res = await s.call(`/verify?next=${encodeURIComponent(next)}`, { redirect: 'manual' });
      expect(res.headers.get('location'), next).toBe('/');
    }
    const res = await googleSignIn(s, 'oauth-cross-site@example.org');
    const cookie = cookieHeader(res);
    const page = await s.call('/verify?next=https%3A%2F%2Fevil.example%2F', {
      headers: { cookie },
    });
    expect(await page.text()).toContain('name="next" value="/"');
    const cross = await s.call('/verify', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'cross-site',
      },
      body: new URLSearchParams({ next: '/', 'cf-turnstile-response': 'pass' }).toString(),
    });
    expect(cross.status).toBe(403);
    expect((await verified('oauth-cross-site@example.org'))?.pool_verified_at).toBeNull();
  });
});

describe('passkeys', () => {
  it('registration needs a session; the relying party is the public host', async () => {
    const s = setup();
    expect((await s.call('/api/auth/passkey/generate-register-options')).status).toBe(401);

    const cookie = cookieHeader(await signIn(s));
    const res = await s.call('/api/auth/passkey/generate-register-options', {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const options = (await res.json()) as {
      rp: { id: string; name: string };
      user: { name: string };
    };
    expect(options.rp).toEqual({ id: 'tangent.example.com', name: 'Tangent' });
    expect(options.user.name).toBe('owner@example.com');
  });

  it('sign-in options are public', async () => {
    const res = await setup().call('/api/auth/passkey/generate-authenticate-options');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rpId: 'tangent.example.com' });
  });
});

describe('sign out', () => {
  it('ends the session', async () => {
    const s = setup();
    const cookie = cookieHeader(await signIn(s));
    const out = await s.call('/api/auth/sign-out', {
      method: 'POST',
      headers: { cookie, origin: BASE },
    });
    expect(out.status).toBe(200);
    expect((await s.call('/api/me', { headers: { cookie } })).status).toBe(401);
  });
});
