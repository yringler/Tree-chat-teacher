import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import { SIGNUPS_CLOSED, type MeResponse } from '@tangent/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api-client';
import { API_FETCH } from './api-fetch';
import { APP_PATHS, type AppPaths } from './app-paths';
import { AUTH_CLIENT, authErrorMessage, type TangentAuthClient } from './auth-client';
import { AuthService, codeErrorMessage, loginErrorMessage } from './auth';

const SIMPLE_PATHS: AppPaths = { home: '/learn/', login: '/learn/login' };

function fakeAuthClient() {
  return {
    getSession: vi.fn(async () => ({ data: null, error: null })),
    signOut: vi.fn(async () => ({ data: { success: true }, error: null })),
    signIn: {
      social: vi.fn(async (_body: unknown) => ({ data: null, error: null })),
      magicLink: vi.fn(async (_body: unknown, _opts?: unknown) => ({ data: null, error: null })),
      passkey: vi.fn(async (_body: unknown) => ({ data: {}, error: null })),
      emailOtp: vi.fn(
        async (
          _body: unknown,
        ): Promise<{ data: unknown; error: { code?: string; status?: number } | null }> => ({
          data: {},
          error: null,
        }),
      ),
    },
  };
}

function setup(paths: AppPaths, me: () => Promise<MeResponse>) {
  const client = fakeAuthClient();
  const api = { me: vi.fn(me), forgetKey: vi.fn(async () => undefined) };
  const injector = Injector.create({
    providers: [
      { provide: AuthService },
      { provide: ApiClient, useValue: api },
      { provide: AUTH_CLIENT, useValue: client as unknown as TangentAuthClient },
      { provide: APP_PATHS, useValue: paths },
    ],
  });
  return { auth: injector.get(AuthService), client, api };
}

const ME: MeResponse = {
  email: 'a@b.c',
  userId: '1',
  accountId: 'u_1',
  mode: 'simple',
  devMode: false,
  operatorKeys: true,
  builtInCredit: true,
  sharing: false,
  isAdmin: false,
  membership: {
    required: false,
    status: 'inactive',
    subscriptionStatus: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
  },
  membershipNeededFor: [],
};

describe('AuthService with APP_PATHS', () => {
  let location: { replace: ReturnType<typeof vi.fn>; assign: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    location = { replace: vi.fn(), assign: vi.fn() };
    vi.stubGlobal('location', {
      ...location,
      origin: 'https://tangent.test',
      protocol: 'https:',
      pathname: '/learn/',
      search: '',
      hash: '',
    });
    vi.stubGlobal('document', { cookie: '' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a signed-out caller to the configured login page', async () => {
    const { auth } = setup(SIMPLE_PATHS, async () => {
      throw new ApiError(401, 'unauthorized', 'expired');
    });
    await expect(auth.requireUser()).resolves.toBeNull();
    expect(location.replace).toHaveBeenCalledWith('/learn/login');
  });

  it('signs out a forbidden caller and shows not_allowed on the configured login page', async () => {
    const { auth, client } = setup(SIMPLE_PATHS, async () => {
      throw new ApiError(403, 'forbidden', 'nope');
    });
    await expect(auth.requireUser()).resolves.toBeNull();
    expect(client.signOut).toHaveBeenCalled();
    expect(location.replace).toHaveBeenCalledWith('/learn/login?error=not_allowed');
  });

  it('a 401 key_required is not a lost session: no login page, no sign-out, the error goes on', async () => {
    const err = new ApiError(401, 'key_required', 'Add your OpenRouter API key to continue.');
    const { auth, client } = setup(SIMPLE_PATHS, async () => {
      throw err;
    });
    await expect(auth.requireUser()).rejects.toBe(err);
    expect(location.replace).not.toHaveBeenCalled();
    expect(location.assign).not.toHaveBeenCalled();
    expect(client.signOut).not.toHaveBeenCalled();
  });

  it('nor is any other 401 with its own code', async () => {
    const err = new ApiError(401, 'rate_limited', 'Slow down');
    const { auth, client } = setup({ home: '/', login: '/login' }, async () => {
      throw err;
    });
    await expect(auth.requireUser()).rejects.toBe(err);
    expect(location.replace).not.toHaveBeenCalled();
    expect(client.signOut).not.toHaveBeenCalled();
  });

  describe('through the real ApiClient', () => {
    function withResponse(res: () => Response) {
      const client = fakeAuthClient();
      const injector = Injector.create({
        providers: [
          { provide: AuthService },
          { provide: ApiClient },
          { provide: API_FETCH, useValue: async () => res() },
          { provide: AUTH_CLIENT, useValue: client as unknown as TangentAuthClient },
          { provide: APP_PATHS, useValue: { home: '/', login: '/login' } },
        ],
      });
      return { auth: injector.get(AuthService), client };
    }
    const json = (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    it('a 401 key_required body keeps the user on the page, with the server message', async () => {
      const message = 'Add your Anthropic API key to continue this conversation.';
      const { auth, client } = withResponse(() =>
        json({ error: { code: 'key_required', message } }, 401),
      );
      await expect(auth.requireUser()).rejects.toMatchObject({ code: 'key_required', message });
      expect(location.replace).not.toHaveBeenCalled();
      expect(client.signOut).not.toHaveBeenCalled();
    });

    it('a 401 unauthorized body sends the browser to sign in', async () => {
      const { auth } = withResponse(() =>
        json({ error: { code: 'unauthorized', message: 'Sign in required' } }, 401),
      );
      await expect(auth.requireUser()).resolves.toBeNull();
      expect(location.replace).toHaveBeenCalledWith('/login?returnTo=%2Flearn%2F');
    });

    it('a 401 without our error body (a proxy) counts as a lost session', async () => {
      const { auth } = withResponse(() => new Response('Unauthorized', { status: 401 }));
      await expect(auth.requireUser()).resolves.toBeNull();
      expect(location.replace).toHaveBeenCalledWith('/login?returnTo=%2Flearn%2F');
    });
  });

  it('returns the caller when signed in', async () => {
    const { auth } = setup(SIMPLE_PATHS, async () => ME);
    await expect(auth.requireUser()).resolves.toEqual(ME);
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('uses home and login as the sign-in callback URLs', async () => {
    const { auth, client } = setup(SIMPLE_PATHS, async () => ME);
    await auth.signInSocial('github', true);
    expect(client.signIn.social).toHaveBeenCalledWith({
      provider: 'github',
      callbackURL: '/learn/',
      errorCallbackURL: '/learn/login',
    });
    await auth.sendMagicLink('a@b.c', 'captcha', false);
    expect(client.signIn.magicLink).toHaveBeenCalledWith(
      { email: 'a@b.c', callbackURL: '/learn/', errorCallbackURL: '/learn/login' },
      { headers: { 'x-captcha-response': 'captcha' } },
    );
  });

  it('lands a passkey sign-in on home and a sign-out on login', async () => {
    const { auth } = setup({ home: '/', login: '/login' }, async () => ME);
    await auth.signInPasskey(true);
    expect(location.assign).toHaveBeenLastCalledWith('/');
    await auth.signOut();
    expect(location.assign).toHaveBeenLastCalledWith('/login');
  });

  it('forgets the stored provider keys before signing out, even when that fails', async () => {
    const { auth, api, client } = setup(SIMPLE_PATHS, async () => ME);
    await auth.signOut();
    expect(api.forgetKey).toHaveBeenCalledWith();
    expect(api.forgetKey.mock.invocationCallOrder[0]).toBeLessThan(
      client.signOut.mock.invocationCallOrder[0]!,
    );
    api.forgetKey.mockRejectedValueOnce(new ApiError(500, 'internal', 'down'));
    await auth.signOut();
    expect(client.signOut).toHaveBeenCalledTimes(2);
    expect(location.assign).toHaveBeenLastCalledWith('/learn/login');
  });
});

describe('AuthService returns a sign-in to the page that asked for it', () => {
  const TARGET = '/learn/t/abc/b/b1?q=a%26b#n_2';
  let location: { replace: ReturnType<typeof vi.fn>; assign: ReturnType<typeof vi.fn> };

  /** The browser at `pathname`, `search` and `hash`. */
  function at(pathname: string, search = '', hash = '') {
    location = { replace: vi.fn(), assign: vi.fn() };
    vi.stubGlobal('location', {
      ...location,
      origin: 'https://tangent.test',
      protocol: 'https:',
      pathname,
      search,
      hash,
    });
    vi.stubGlobal('document', { cookie: '' });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a lost session on a deep link goes to login carrying the whole URL', async () => {
    at('/learn/t/abc/b/b1', '?q=a%26b', '#n_2');
    const { auth } = setup(SIMPLE_PATHS, async () => {
      throw new ApiError(401, 'unauthorized', 'expired');
    });
    await expect(auth.requireUser()).resolves.toBeNull();
    expect(location.replace).toHaveBeenCalledWith(
      `/learn/login?returnTo=${encodeURIComponent(TARGET)}`,
    );
  });

  it('a forbidden caller keeps the target next to the error', async () => {
    at('/admin/users');
    const { auth } = setup({ home: '/admin/', login: '/login' }, async () => {
      throw new ApiError(403, 'forbidden', 'nope');
    });
    await auth.requireUser();
    expect(location.replace).toHaveBeenCalledWith(
      '/login?error=not_allowed&returnTo=%2Fadmin%2Fusers',
    );
  });

  it('every sign-in method on a login page with returnTo lands on the target', async () => {
    at('/learn/login', `?returnTo=${encodeURIComponent(TARGET)}`);
    const { auth, client } = setup(SIMPLE_PATHS, async () => ME);
    expect(auth.signInDestination()).toBe(TARGET);
    const loginAgain = `/learn/login?returnTo=${encodeURIComponent(TARGET)}`;

    await auth.signInSocial('google', true);
    expect(client.signIn.social).toHaveBeenCalledWith({
      provider: 'google',
      callbackURL: TARGET,
      errorCallbackURL: loginAgain,
    });

    // The magic-link verify decodes its callback URLs once more than the link
    // encodes them, so their `%` go escaped.
    await auth.sendMagicLink('a@b.c', 'captcha', true);
    expect(client.signIn.magicLink).toHaveBeenCalledWith(
      {
        email: 'a@b.c',
        callbackURL: TARGET.replaceAll('%', '%25'),
        errorCallbackURL: loginAgain.replaceAll('%', '%25'),
      },
      { headers: { 'x-captcha-response': 'captcha' } },
    );

    await auth.signInPasskey(true);
    expect(location.assign).toHaveBeenLastCalledWith(TARGET);

    await auth.signInWithCode('a@b.c', '123456', true);
    expect(client.signIn.emailOtp).toHaveBeenCalledWith({ email: 'a@b.c', otp: '123456' });
    expect(location.assign).toHaveBeenLastCalledWith(TARGET);
  });

  it('ignores a returnTo that could leave the site', async () => {
    for (const evil of ['//evil.example/', 'https://evil.example/', '/\\evil.example']) {
      at('/login', `?returnTo=${encodeURIComponent(evil)}`);
      const { auth, client } = setup({ home: '/', login: '/login' }, async () => ME);
      expect(auth.signInDestination()).toBe('/');
      await auth.signInSocial('github', true);
      expect(client.signIn.social).toHaveBeenCalledWith({
        provider: 'github',
        callbackURL: '/',
        errorCallbackURL: '/login',
      });
      await auth.signInPasskey(true);
      expect(location.assign).toHaveBeenLastCalledWith('/');
    }
  });
});

describe('signing in with the emailed code', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { assign: vi.fn(), pathname: '/login', search: '', hash: '' });
    vi.stubGlobal('document', { cookie: '' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carries the remember-me choice and stays on the page when the code is refused', async () => {
    const { auth, client } = setup({ home: '/', login: '/login' }, async () => ME);
    client.signIn.emailOtp.mockResolvedValueOnce({
      data: null,
      error: { code: 'INVALID_OTP', status: 400 },
    });
    await expect(auth.signInWithCode('a@b.c', '000000', false)).resolves.toEqual({
      text: "That code isn't right. Check the email and try again.",
      spent: false,
    });
    expect(document.cookie).toContain('tangent-remember=0');
    expect(location.assign).not.toHaveBeenCalled();
  });

  it('marks an expired or exhausted code spent, so only a new email helps', () => {
    expect(codeErrorMessage({ code: 'OTP_EXPIRED', status: 400 }).spent).toBe(true);
    expect(codeErrorMessage({ code: 'TOO_MANY_ATTEMPTS', status: 403 }).spent).toBe(true);
    expect(codeErrorMessage({ status: 429 })).toEqual({
      text: 'Too many attempts. Wait a minute and try again.',
      spent: false,
    });
  });
});

describe('a sign-up refused at the user cap', () => {
  it('says the app is full and points to the waitlist, on the login page and on a link request', () => {
    const fromRedirect = loginErrorMessage(SIGNUPS_CLOSED, 'Tangent Learn');
    expect(fromRedirect).toContain("Tangent Learn is full for now and isn't taking new accounts.");
    expect(fromRedirect).toContain('Join the waitlist');
    const fromRequest = authErrorMessage({ status: 403, code: SIGNUPS_CLOSED, message: 'raw' });
    expect(fromRequest).toContain("Tangent is full for now and isn't taking new accounts.");
  });
});
