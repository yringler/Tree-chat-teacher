import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import type { MeResponse } from '@tangent/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api-client';
import { API_FETCH } from './api-fetch';
import { APP_PATHS, type AppPaths } from './app-paths';
import { AUTH_CLIENT, type TangentAuthClient } from './auth-client';
import { AuthService } from './auth';

const SIMPLE_PATHS: AppPaths = { home: '/learn/', login: '/learn/login' };

function fakeAuthClient() {
  return {
    getSession: vi.fn(async () => ({ data: null, error: null })),
    signOut: vi.fn(async () => ({ data: { success: true }, error: null })),
    signIn: {
      social: vi.fn(async (_body: unknown) => ({ data: null, error: null })),
      magicLink: vi.fn(async (_body: unknown, _opts?: unknown) => ({ data: null, error: null })),
      passkey: vi.fn(async (_body: unknown) => ({ data: {}, error: null })),
    },
  };
}

function setup(paths: AppPaths, me: () => Promise<MeResponse>) {
  const client = fakeAuthClient();
  const api = { me: vi.fn(me) };
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
    includedCreditCents: 200,
  },
  membershipNeededFor: [],
  featuredConversations: false,
};

describe('AuthService with APP_PATHS', () => {
  let location: { replace: ReturnType<typeof vi.fn>; assign: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    location = { replace: vi.fn(), assign: vi.fn() };
    vi.stubGlobal('location', { ...location, origin: 'https://tangent.test', protocol: 'https:' });
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
      expect(location.replace).toHaveBeenCalledWith('/login');
    });

    it('a 401 without our error body (a proxy) counts as a lost session', async () => {
      const { auth } = withResponse(() => new Response('Unauthorized', { status: 401 }));
      await expect(auth.requireUser()).resolves.toBeNull();
      expect(location.replace).toHaveBeenCalledWith('/login');
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
});
