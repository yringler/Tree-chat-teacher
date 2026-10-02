import { inject, Injectable } from '@angular/core';
import { passkeyClient } from '@better-auth/passkey/client';
import type { LoginOptionsResponse, MeResponse } from '@tangent/shared';
import { createAuthClient } from 'better-auth/client';
import { magicLinkClient } from 'better-auth/client/plugins';
import { ApiClient, ApiError } from './api-client';

export type SocialProvider = 'google' | 'github';

export interface PasskeyInfo {
  id: string;
  name: string | null;
  createdAt: string | null;
  deviceType: string;
  backedUp: boolean;
}

/** Must match REMEMBER_COOKIE in apps/worker/src/auth/auth.ts. */
const REMEMBER_COOKIE = 'tangent-remember';
const REMEMBER_PREF_KEY = 'tangent.rememberMe';
/** Long enough to finish an OAuth round trip or open the magic-link email. */
const REMEMBER_COOKIE_SECONDS = 15 * 60;

export const LOGIN_PATH = '/login';

/**
 * Sign-in, sign-out and passkeys, on top of Better Auth's browser client
 * (`/api/auth/*`). Session cookies are HttpOnly; nothing here can read them.
 *
 * Moving between the app and the login page is always a full page load
 * (`location.assign`), never a router navigation: the login page is served
 * with its own CSP that allows Cloudflare Turnstile, which the app's CSP
 * doesn't (see public/_headers).
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiClient);
  private readonly client = createAuthClient({
    baseURL: location.origin,
    basePath: '/api/auth',
    plugins: [magicLinkClient(), passkeyClient()],
  });

  async loginOptions(): Promise<LoginOptionsResponse> {
    const res = await fetch('/api/login-options', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Couldn't load sign-in options (${res.status})`);
    return (await res.json()) as LoginOptionsResponse;
  }

  /**
   * The signed-in caller, or null when this sends the browser to the login
   * page instead (no session, or an account no longer allowed in).
   */
  async requireUser(): Promise<MeResponse | null> {
    try {
      const me = await this.api.me();
      // Rolls a remembered session forward; the API itself never refreshes sessions.
      if (!me.devMode) void this.hasSession().catch(() => undefined);
      return me;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        location.replace(LOGIN_PATH);
        return null;
      }
      if (err instanceof ApiError && err.status === 403) {
        await this.client.signOut().catch(() => undefined);
        location.replace(`${LOGIN_PATH}?error=not_allowed`);
        return null;
      }
      throw err;
    }
  }

  /** True when a session exists. Also rolls a remembered session's expiry forward (and re-issues its cookie). */
  async hasSession(): Promise<boolean> {
    const { data } = await this.client.getSession();
    return !!data;
  }

  // ---- Remember me

  get rememberPreference(): boolean {
    try {
      return localStorage.getItem(REMEMBER_PREF_KEY) !== 'false';
    } catch {
      return true;
    }
  }

  /**
   * Stored for next time, and handed to the server as a short-lived cookie
   * that the sign-in completion (OAuth callback, magic link, passkey) reads.
   * The login page also calls this whenever the checkbox changes, because a
   * passkey picked from autofill completes a request started at page load.
   */
  setRemember(remember: boolean): void {
    try {
      localStorage.setItem(REMEMBER_PREF_KEY, String(remember));
    } catch {
      // Storage unavailable: the cookie below still carries the choice.
    }
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${REMEMBER_COOKIE}=${remember ? '1' : '0'}; Path=/api/auth; Max-Age=${REMEMBER_COOKIE_SECONDS}; SameSite=Lax${secure}`;
  }

  // ---- Sign-in. Each resolves with an error message, or navigates away on success.

  async signInSocial(provider: SocialProvider, remember: boolean): Promise<string | null> {
    this.setRemember(remember);
    // On success the client follows the provider's redirect itself.
    const { error } = await this.client.signIn.social({
      provider,
      callbackURL: '/',
      errorCallbackURL: LOGIN_PATH,
    });
    return error ? messageFor(error) : null;
  }

  async sendMagicLink(
    email: string,
    captchaToken: string,
    remember: boolean,
  ): Promise<string | null> {
    this.setRemember(remember);
    const { error } = await this.client.signIn.magicLink(
      { email, callbackURL: '/', errorCallbackURL: LOGIN_PATH },
      { headers: { 'x-captcha-response': captchaToken } },
    );
    return error ? messageFor(error) : null;
  }

  /** `autoFill`: conditional UI, i.e. offer passkeys in the email field's autofill. */
  async signInPasskey(remember: boolean, autoFill = false): Promise<string | null> {
    this.setRemember(remember);
    const res = await this.client.signIn.passkey({ autoFill });
    if (res?.error) return autoFill ? null : messageFor(res.error);
    location.assign('/');
    return null;
  }

  async signOut(): Promise<void> {
    await this.client.signOut();
    location.assign(LOGIN_PATH);
  }

  // ---- Passkeys (signed in)

  async listPasskeys(): Promise<PasskeyInfo[]> {
    const { data, error } = await this.client.passkey.listUserPasskeys();
    if (error) throw new Error(messageFor(error));
    return (data ?? []).map((p) => ({
      id: p.id,
      name: p.name ?? null,
      createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
      deviceType: p.deviceType,
      backedUp: p.backedUp,
    }));
  }

  async addPasskey(name: string): Promise<string | null> {
    const res = await this.client.passkey.addPasskey(name ? { name } : {});
    return res?.error ? messageFor(res.error) : null;
  }

  async deletePasskey(id: string): Promise<string | null> {
    const { error } = await this.client.passkey.deletePasskey({ id });
    return error ? messageFor(error) : null;
  }
}

/** Login-page messages for `?error=` codes from OAuth and magic-link redirects. */
export function loginErrorMessage(code: string | null): string | null {
  if (!code) return null;
  switch (code) {
    case 'unable_to_create_user':
      return "Your account couldn't be created. Please try again.";
    case 'INVALID_TOKEN':
    case 'EXPIRED_TOKEN':
    case 'ATTEMPTS_EXCEEDED':
      return 'That sign-in link has expired or was already used. Request a new one.';
    case 'access_denied':
      return 'Sign-in was cancelled.';
    default:
      return 'Sign-in failed. Please try again.';
  }
}

function messageFor(error: {
  message?: string | undefined;
  status?: number;
  code?: string | undefined;
}): string {
  if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
  return error.message || 'Something went wrong. Please try again.';
}
