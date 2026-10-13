import {
  REMEMBER_COOKIE,
  SIGNUPS_CLOSED,
  type LoginOptionsResponse,
  type MeResponse,
} from '@tangent/shared';
import { Hono } from 'hono';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { signedInPage } from '../src/auth/session.js';
import type { AppBindings } from '../src/env.js';
import type { EmailMessage, EmailSender } from '../src/email/index.js';
import type { AppEnv } from '../src/env.js';
import { BASE } from './http.js';

const SESSION_COOKIE = '__Secure-tangent.session_token';
const DONT_REMEMBER_COOKIE = '__Secure-tangent.dont_remember';
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

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
      accountId: 'default_simple',
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
      accountId: 'default_simple',
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
      signupsOpen: true,
    } satisfies LoginOptionsResponse);
  });

  it('is public, and says so when auth is not configured', async () => {
    const { call } = setup(authEnv({ BETTER_AUTH_SECRET: '', TURNSTILE_SITE_KEY: '' }));
    expect(await (await call('/api/login-options')).json()).toEqual({
      configured: false,
      devMode: true,
      social: { google: false, github: false },
      turnstileSiteKey: null,
      signupsOpen: true,
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

  it('refuses a captcha solved on another host', async () => {
    const s = setup();
    expect((await requestMagicLink(s.call, 'owner@example.com', 'pass-elsewhere')).status).toBe(
      403,
    );
    expect(s.mail.sent).toHaveLength(0);
  });

  it("passes any captcha with Turnstile's always-pass test secret, whatever its hostname", async () => {
    const s = setup(
      authEnv({ TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET, POLAR_SERVER: 'sandbox' }),
    );
    expect(
      (await requestMagicLink(s.call, 'owner@example.com', 'XXXX.DUMMY.TOKEN.XXXX')).status,
    ).toBe(200);
    expect(s.mail.sent).toHaveLength(1);
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
    expect(body.accountId).toMatch(/^u_.+/);
    expect(body.userId).toBe(body.accountId.slice('u_'.length));
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
    expect(me.accountId).toMatch(/^u_.+/);
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

describe('sign-in by code', () => {
  const DAY = 24 * 60 * 60 * 1000;

  function codeFrom(message: EmailMessage): string {
    const m = /sign-in code: (\d{6})/.exec(message.text);
    if (!m) throw new Error('no code in email');
    return m[1]!;
  }

  /** Requests the email (link and code) for `email` and returns its code. */
  async function requestCode(s: ReturnType<typeof setup>, email: string): Promise<string> {
    expect((await requestMagicLink(s.call, email)).status).toBe(200);
    return codeFrom(s.mail.sent.at(-1)!);
  }

  /**
   * `POST /api/auth/sign-in/email-otp` as the native app sends it: no cookie,
   * no Origin. `call` defaults to a fresh client IP, as Better Auth allows
   * three tries a minute per IP.
   */
  async function submitCode(
    email: string,
    otp: string,
    opts: { call?: ReturnType<typeof setup>['call']; env?: AppEnv; cookie?: string } = {},
  ): Promise<Response> {
    const call = opts.call ?? setup(opts.env).call;
    return call('/api/auth/sign-in/email-otp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.cookie ? { cookie: opts.cookie, origin: BASE } : {}),
      },
      body: JSON.stringify({ email, otp }),
    });
  }

  async function sessionExpiry(token: string): Promise<number> {
    const row = await env.DB.prepare('SELECT expires_at FROM auth_sessions WHERE token = ?')
      .bind(token.split('.')[0])
      .first<{ expires_at: number }>();
    return row!.expires_at - Date.now();
  }

  it('the sign-in email carries both the link and a 6-digit code', async () => {
    const s = setup();
    const code = await requestCode(s, 'both@example.com');
    const mail = s.mail.sent[0]!;
    expect(mail.text).toContain('/api/auth/magic-link/verify');
    expect(code).toMatch(/^\d{6}$/);
    expect(mail.html).toContain(code);
    // The code is stored encrypted, never as itself.
    const row = await env.DB.prepare('SELECT value FROM auth_verifications WHERE identifier = ?')
      .bind('sign-in-otp-both@example.com')
      .first<{ value: string }>();
    expect(row!.value).not.toContain(code);
  });

  it('signs in a new address by code, creating a verified account, with a bearer token', async () => {
    const s = setup();
    const code = await requestCode(s, 'Coder@Example.com');
    const res = await submitCode('coder@example.com', code);
    expect(res.status).toBe(200);
    const token = res.headers.get('set-auth-token');
    expect(token).toMatch(/^[^.]+\..+$/);
    const me = await s.call('/api/me', { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'coder@example.com', devMode: false });
    const user = await env.DB.prepare('SELECT email_verified FROM auth_users WHERE email = ?')
      .bind('coder@example.com')
      .first<{ email_verified: number }>();
    expect(user?.email_verified).toBe(1);
    // A client without cookies (the app) keeps its token: the normal 30-day session.
    expect(await sessionExpiry(token!)).toBeGreaterThan(29 * DAY);
  });

  it('a browser that asked not to be remembered gets a 1-day session by code too', async () => {
    const s = setup();
    const code = await requestCode(s, 'shared-computer@example.com');
    const res = await submitCode('shared-computer@example.com', code, {
      cookie: `${REMEMBER_COOKIE}=0`,
    });
    expect(res.status).toBe(200);
    expect(findSetCookie(res, SESSION_COOKIE)).not.toMatch(/Max-Age/i);
    expect(await sessionExpiry(res.headers.get('set-auth-token')!)).toBeLessThanOrEqual(DAY);
    // A browser that asked to be remembered gets the persistent cookie.
    const s2 = setup();
    const code2 = await requestCode(s2, 'own-laptop@example.com');
    const res2 = await submitCode('own-laptop@example.com', code2, {
      cookie: `${REMEMBER_COOKIE}=1`,
    });
    expect(findSetCookie(res2, SESSION_COOKIE)).toMatch(/Max-Age=2592000/);
  });

  it('refuses a wrong code, and after three wrong ones the right one too', async () => {
    const s = setup();
    const code = await requestCode(s, 'guesser@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) {
      const res = await submitCode('guesser@example.com', wrong);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_OTP' });
    }
    const res = await submitCode('guesser@example.com', code);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    expect(res.headers.get('set-auth-token')).toBeNull();
    // A new email brings a new code that works.
    const fresh = await requestCode(s, 'guesser@example.com');
    expect((await submitCode('guesser@example.com', fresh)).status).toBe(200);
  });

  it('a code works once', async () => {
    const s = setup();
    const code = await requestCode(s, 'once@example.com');
    expect((await submitCode('once@example.com', code)).status).toBe(200);
    const again = await submitCode('once@example.com', code);
    expect(again.status).toBe(400);
    expect(again.headers.get('set-auth-token')).toBeNull();
  });

  it('an expired code is refused', async () => {
    const s = setup();
    const code = await requestCode(s, 'late@example.com');
    await env.DB.prepare('UPDATE auth_verifications SET expires_at = ? WHERE identifier = ?')
      .bind(Date.now() - 1000, 'sign-in-otp-late@example.com')
      .run();
    const res = await submitCode('late@example.com', code);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('a code expires with its link, after 15 minutes', async () => {
    const s = setup();
    await requestCode(s, 'quarter-hour@example.com');
    const row = await env.DB.prepare(
      'SELECT expires_at FROM auth_verifications WHERE identifier = ?',
    )
      .bind('sign-in-otp-quarter-hour@example.com')
      .first<{ expires_at: number }>();
    const left = row!.expires_at - Date.now();
    expect(left).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(left).toBeGreaterThan(14 * 60 * 1000);
  });

  it('a code only comes in the captcha-gated sign-in email: the plugin’s other endpoints are off', async () => {
    const s = setup();
    for (const path of [
      '/email-otp/send-verification-otp',
      '/email-otp/check-verification-otp',
      '/email-otp/verify-email',
      '/email-otp/request-password-reset',
      '/forget-password/email-otp',
      '/email-otp/reset-password',
      '/email-otp/request-email-change',
      '/email-otp/change-email',
    ]) {
      const res = await s.call(`/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'bypass@example.com', type: 'sign-in', otp: '123456' }),
      });
      expect(res.status, path).toBe(404);
    }
    expect(s.mail.sent).toHaveLength(0);
  });

  it('records the Turnstile pass while the pool is on, as the link does', async () => {
    const e = authEnv({ POOL_ENABLED: 'true' });
    const s = setup(e);
    const code = await requestCode(s, 'code-verified@example.org');
    expect((await submitCode('code-verified@example.org', code, { env: e })).status).toBe(200);
    const row = await env.DB.prepare('SELECT pool_verified_at FROM auth_users WHERE email = ?')
      .bind('code-verified@example.org')
      .first<{ pool_verified_at: string | null }>();
    expect(row?.pool_verified_at).toBeTruthy();
  });

  it('a code requested while there was room is refused once full', async () => {
    const count = async () =>
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_users').first<{ n: number }>())!.n;
    const e = authEnv({ MAX_USERS: String((await count()) + 1) });
    const s = setup(e);
    const code = await requestCode(s, 'slow-typist@example.com');
    await signIn(setup(authEnv({ MAX_USERS: '' })), 'fast-typist@example.com');
    const res = await submitCode('slow-typist@example.com', code, { env: e });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: SIGNUPS_CLOSED });
  });

  it('the bearer token must be the signed one, and signing out ends it', async () => {
    const s = setup();
    const code = await requestCode(s, 'bearer@example.com');
    const res = await submitCode('bearer@example.com', code);
    const token = res.headers.get('set-auth-token')!;
    const raw = ((await res.json()) as { token: string }).token;
    expect(token.startsWith(`${raw}.`)).toBe(true);
    const me = (authorization: string) => s.call('/api/me', { headers: { authorization } });
    expect((await me(`Bearer ${raw}`)).status).toBe(401);
    expect((await me(`Bearer ${raw}.forged`)).status).toBe(401);
    expect((await me(`Bearer ${token}`)).status).toBe(200);
    const session = await s.call('/api/auth/get-session', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await session.json()).toMatchObject({ user: { email: 'bearer@example.com' } });
    // The token is handed out on the code sign-in only, not on every session response.
    expect(session.headers.get('set-auth-token')).toBeNull();
    const out = await s.call('/api/auth/sign-out', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.status).toBe(200);
    expect((await me(`Bearer ${token}`)).status).toBe(401);
  });

  it('the web sign-ins hand out no bearer token: their session stays in the HttpOnly cookie', async () => {
    const res = await signIn(setup(), 'web-only@example.com');
    expect(findSetCookie(res, SESSION_COOKIE)).toBeDefined();
    expect(res.headers.get('set-auth-token')).toBeNull();
  });
  it('the reviewer email gets the fixed code every time, and no email', async () => {
    const e = authEnv({ REVIEWER_SIGN_IN: 'Play-Review@example.com:424242' });
    for (let i = 0; i < 2; i++) {
      const s = setup(e);
      expect((await requestMagicLink(s.call, 'play-review@example.com')).status).toBe(200);
      expect(s.mail.sent).toEqual([]);
      const res = await submitCode('play-review@example.com', '424242', { env: e });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-auth-token')).toMatch(/^[^.]+\..+$/);
    }
    // Everyone else still gets a random code by email.
    const other = setup(e);
    const code = await requestCode(other, 'someone@example.com');
    expect(code).toMatch(/^\d{6}$/);
    expect(other.mail.sent).toHaveLength(1);
  });
});

describe('the app’s captcha page', () => {
  it('shows only the Turnstile widget, with a script of its own that hands the token to the app', async () => {
    const s = setup();
    const page = await s.call('/app-captcha');
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src https://challenges.cloudflare.com 'self'");
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain('class="cf-turnstile" data-sitekey="site-key"');
    expect(html).toContain('data-callback="tangentCaptchaPassed"');
    expect(html).toContain('<script src="/app-captcha.js"></script>');
    // Nothing to navigate away to inside the app's web view.
    expect(html).not.toContain('<header');
    expect(html).not.toMatch(/<a\s/);

    const script = await s.call('/app-captcha.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const js = await script.text();
    expect(js).toContain('TangentCaptcha.postMessage');
    expect(js).toContain('tangentCaptchaPassed');
  });

  it('is not found where Turnstile is not configured', async () => {
    const s = setup(authEnv({ TURNSTILE_SITE_KEY: '' }));
    expect((await s.call('/app-captcha')).status).toBe(404);
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

  it('refuses a Google sign-up once MAX_USERS is reached, back on the login page', async () => {
    const { n } = (await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_users').first<{
      n: number;
    }>())!;
    const res = await googleSignIn(
      setup(googleEnv({ MAX_USERS: String(n) })),
      'late-googler@example.org',
      true,
    );
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location') ?? '', BASE);
    expect(to.pathname).toBe('/login');
    expect(to.searchParams.get('error')).toBe(SIGNUPS_CLOSED);
    expect(findSetCookie(res, SESSION_COOKIE)).toBeUndefined();
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

describe('MAX_USERS', () => {
  const userCount = async () =>
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_users').first<{ n: number }>())!.n;
  const userExists = async (email: string) =>
    (await env.DB.prepare('SELECT id FROM auth_users WHERE email = ?').bind(email).first()) !==
    null;
  /** Where a sign-in redirect lands, as a path and query on this origin. */
  const landing = (res: Response) => {
    const url = new URL(res.headers.get('location') ?? '', BASE);
    return url.pathname + url.search;
  };

  it('refuses a new address once the cap is reached, before sending a link', async () => {
    const s = setup(authEnv({ MAX_USERS: String(await userCount()) }));
    const res = await requestMagicLink(s.call, 'newcomer-full@example.com');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: SIGNUPS_CLOSED });
    expect(s.mail.sent).toHaveLength(0);
  });

  it('checks the captcha first, so a full deployment reveals nothing without one', async () => {
    const s = setup(authEnv({ MAX_USERS: String(await userCount()) }));
    const res = await requestMagicLink(s.call, 'prober@example.com', null);
    expect(res.status).toBe(400);
    expect(await res.json()).not.toMatchObject({ code: SIGNUPS_CLOSED });
  });

  it('still signs in an existing user when full', async () => {
    const first = setup();
    await signIn(first, 'early-bird@example.com');
    const s = setup(authEnv({ MAX_USERS: String(await userCount()) }));
    const res = await signIn(s, 'Early-Bird@example.com');
    expect(res.status).toBe(302);
    expect(landing(res)).toBe('/');
  });

  it('signs up while there is room, and the next one is refused', async () => {
    const e = authEnv({ MAX_USERS: String((await userCount()) + 1) });
    const ok = await signIn(setup(e), 'last-seat@example.com');
    expect(landing(ok)).toBe('/');
    const res = await requestMagicLink(setup(e).call, 'one-too-many@example.com');
    expect(res.status).toBe(403);
    expect(await userExists('one-too-many@example.com')).toBe(false);
  });

  it('a link requested while there was room is refused once full, back on the login page', async () => {
    const s = setup(authEnv({ MAX_USERS: String((await userCount()) + 1) }));
    expect((await requestMagicLink(s.call, 'slow-clicker@example.com')).status).toBe(200);
    await signIn(setup(authEnv({ MAX_USERS: '' })), 'fast-clicker@example.com');
    const link = new URL(linkFrom(s.mail.sent.at(-1)!));
    const res = await s.call(link.pathname + link.search, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location') ?? '', BASE);
    expect(to.pathname).toBe('/login');
    expect(to.searchParams.get('error')).toBe(SIGNUPS_CLOSED);
    expect(await userExists('slow-clicker@example.com')).toBe(false);
  });

  it('unset or 0 means no cap', async () => {
    for (const cap of ['', '0']) {
      const res = await signIn(setup(authEnv({ MAX_USERS: cap })), `uncapped-${cap}@example.com`);
      expect(landing(res)).toBe('/');
    }
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

describe('back to the page that asked for a sign-in', () => {
  /** A deep link into Learn, with a query and a hash. */
  const TARGET = '/learn/t/abc/b/b1?q=a%26b#n_2';
  const LOGIN_WITH_TARGET = `/learn/login?returnTo=${encodeURIComponent(TARGET)}`;
  /**
   * The magic-link verify decodes its callback URLs once more than the link
   * encoded them, so the web client sends each with its `%` escaped
   * (AuthService); the link then lands on the target exactly.
   */
  const escapePercent = (url: string) => url.replaceAll('%', '%25');

  function requestLinkTo(s: ReturnType<typeof setup>, email: string) {
    return s.call('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, 'x-captcha-response': 'pass' },
      body: JSON.stringify({
        email,
        callbackURL: escapePercent(TARGET),
        errorCallbackURL: escapePercent(LOGIN_WITH_TARGET),
      }),
    });
  }

  it('a magic link lands on the target, and a spent one back on the login page with it', async () => {
    const s = setup();
    expect((await requestLinkTo(s, 'deep-link@example.org')).status).toBe(200);
    const link = new URL(linkFrom(s.mail.sent.at(-1)!));
    const res = await s.call(link.pathname + link.search, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}${TARGET}`);
    expect(findSetCookie(res, SESSION_COOKIE)).toBeDefined();

    const again = await s.call(link.pathname + link.search, { redirect: 'manual' });
    const to = new URL(again.headers.get('location') ?? '', BASE);
    expect(to.pathname).toBe('/learn/login');
    expect(to.searchParams.get('returnTo')).toBe(TARGET);
    expect(to.searchParams.get('error')).toBe('INVALID_TOKEN');
  });

  async function googleTo(s: ReturnType<typeof setup>, email: string) {
    const start = await s.call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({
        provider: 'google',
        callbackURL: TARGET,
        errorCallbackURL: LOGIN_WITH_TARGET,
      }),
    });
    expect(start.status).toBe(200);
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')!;
    return s.call(
      `/api/auth/callback/google?code=${encodeURIComponent(email)}&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `${cookieHeader(start)}; ${REMEMBER_COOKIE}=1` }, redirect: 'manual' },
    );
  }
  const google = (pool: boolean) =>
    authEnv({
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: 'gsecret',
      POOL_ENABLED: String(pool),
    });

  it('the OAuth state carries the target through the provider and back', async () => {
    const res = await googleTo(setup(google(false)), 'deep-google@example.org');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(TARGET);

    const refused = await googleTo(setup(google(false)), 'unverified-deep@example.org');
    const to = new URL(refused.headers.get('location') ?? '', BASE);
    expect(to.pathname).toBe('/learn/login');
    expect(to.searchParams.get('returnTo')).toBe(TARGET);
    expect(to.searchParams.get('error')).toBe('unable_to_create_user');
  });

  it('the first-sign-in interstitial continues to the target, query and hash included', async () => {
    const s = setup(google(true));
    const res = await googleTo(s, 'deep-first@example.org');
    expect(res.headers.get('location')).toBe(`/verify?next=${encodeURIComponent(TARGET)}`);
    const page = await s.call(`/verify?next=${encodeURIComponent(TARGET)}`, {
      headers: { cookie: cookieHeader(res) },
    });
    expect(await page.text()).toContain(`name="next" value="${TARGET.replace('&', '&amp;')}"`);
  });

  describe('a Worker page behind signedInPage', () => {
    function pages(loginPath?: string) {
      const app = new Hono<AppBindings>();
      app.get('/delete-account', signedInPage(loginPath ? { loginPath } : {}), (c) =>
        c.text(`hello ${c.var.identity.email ?? ''}`),
      );
      return app;
    }

    it('sends a signed-out visitor to the login page with the page as returnTo', async () => {
      const res = await pages().request(`${BASE}/delete-account?from=email`, {}, authEnv());
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(
        `/login?returnTo=${encodeURIComponent('/delete-account?from=email')}`,
      );
      expect(res.headers.get('cache-control')).toBe('no-store');

      const learn = await pages('/learn/login').request(`${BASE}/delete-account`, {}, authEnv());
      expect(learn.headers.get('location')).toBe('/learn/login?returnTo=%2Fdelete-account');
    });

    it('serves a signed-in user, who reaches it straight from the sign-in', async () => {
      const s = setup();
      const cookie = cookieHeader(await signIn(s, 'leaving@example.org'));
      const res = await pages().request(
        `${BASE}/delete-account`,
        { headers: { cookie } },
        authEnv(),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hello leaving@example.org');
    });
  });
});
