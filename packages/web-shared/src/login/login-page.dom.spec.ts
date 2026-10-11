import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import type { LoginOptionsResponse } from '@tangent/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_FETCH } from '../core/api-fetch';
import { APP_PATHS } from '../core/app-paths';
import { AUTH_CLIENT } from '../core/auth-client';
import { render } from '../testing';
import { LoginPage } from './login-page';

const OPTIONS: LoginOptionsResponse = {
  configured: true,
  devMode: false,
  social: { google: false, github: false },
  turnstileSiteKey: 'site-key',
  signupsOpen: false,
};

/** The login page against a server answering login-options with `options`; returns its requests. */
async function loginPage(options: LoginOptionsResponse) {
  const requests: { url: string; body: unknown }[] = [];
  const fetchFake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/api/login-options')) return Response.json(options);
    return new Response(null, { status: 204 });
  });
  await render(LoginPage, {
    providers: [
      { provide: API_FETCH, useValue: fetchFake },
      { provide: APP_PATHS, useValue: { home: '/', login: '/login' } },
      {
        provide: AUTH_CLIENT,
        useValue: { getSession: async () => ({ data: null, error: null }) },
      },
    ],
  });
  await screen.findByRole('button', { name: 'Email me a sign-in link' });
  return { requests, user: userEvent.setup() };
}

describe('LoginPage while sign-ups are closed', () => {
  beforeEach(() => {
    // A solved widget: Turnstile hands over its token at once.
    window.turnstile = {
      render: (_el, opts) => {
        opts.callback('pass');
        return 'widget';
      },
      reset: () => undefined,
      remove: () => undefined,
    };
  });

  afterEach(() => {
    delete window.turnstile;
  });

  it('says so, and puts a new address on the waitlist', async () => {
    const { requests, user } = await loginPage(OPTIONS);
    expect(screen.getByRole('status').textContent).toContain('Tangent is full for now.');
    // Not "create an account": that is what is closed.
    expect(screen.queryByText('Sign in or create an account')).toBeNull();
    await user.type(screen.getByLabelText('Email'), 'newcomer@example.com');
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }));
    expect(await screen.findByText("You're on the waitlist")).toBeTruthy();
    expect(requests.at(-1)).toEqual({
      url: '/api/waitlist',
      body: { email: 'newcomer@example.com', captchaToken: 'pass' },
    });
  });

  it('offers no waitlist while sign-ups are open', async () => {
    await loginPage({ ...OPTIONS, signupsOpen: true });
    expect(screen.queryByRole('button', { name: 'Join the waitlist' })).toBeNull();
    expect(screen.queryByText(/is full for now/)).toBeNull();
    expect(screen.getByText('Sign in or create an account')).toBeTruthy();
  });
});
