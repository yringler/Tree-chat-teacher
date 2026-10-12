import { inject, Injectable } from '@angular/core';
import {
  API_ROUTES,
  AUTH_BASE_PATH,
  loginUrl,
  REMEMBER_COOKIE,
  RETURN_TO_PARAM,
  routeUrl,
  safeReturnPath,
  SIGNUPS_CLOSED,
  type LoginOptionsResponse,
  type MeResponse,
} from '@tangent/shared';
import { ApiClient, ApiError, errorMessage, hasCode } from './api-client';
import { API_FETCH, defaultApiFetch } from './api-fetch';
import { AUTH_CLIENT, authErrorMessage as messageFor, signupsClosedMessage } from './auth-client';
import { APP_PATHS } from './app-paths';

export type SocialProvider = 'google' | 'github';

export interface PasskeyInfo {
  id: string;
  name: string | null;
  createdAt: string | null;
  deviceType: string;
  backedUp: boolean;
}

const REMEMBER_PREF_KEY = 'tangent.rememberMe';
/** Long enough to finish an OAuth round trip or open the magic-link email. */
const REMEMBER_COOKIE_SECONDS = 15 * 60;

/**
 * Sign-in, sign-out and passkeys, on top of Better Auth's browser client
 * (`/api/auth/*`). Session cookies are HttpOnly; nothing here can read them.
 *
 * Moving between the app and the login page is always a full page load
 * (`location.assign`), never a router navigation: the login page is served
 * with its own CSP that allows Cloudflare Turnstile, which the app's CSP
 * doesn't (see public/_headers).
 *
 * Where "home" and "login" are comes from the app's APP_PATHS. A signed-out
 * visit is sent to login with the page it asked for as `returnTo`
 * (`requireUser`), and every sign-in started on that login page lands there
 * instead of home (`signInDestination`). The target rides in each method's
 * callback URL, so it survives the round trip to an OAuth provider (Better
 * Auth keeps it in the OAuth state) and the magic link (it is in the link).
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiClient);
  private readonly paths = inject(APP_PATHS);
  private readonly client = inject(AUTH_CLIENT);
  private readonly transport = inject(API_FETCH, { optional: true }) ?? defaultApiFetch;

  async loginOptions(): Promise<LoginOptionsResponse> {
    const transport = this.transport;
    const res = await transport(routeUrl(API_ROUTES.loginOptions), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Couldn't load sign-in options (${res.status})`);
    return (await res.json()) as LoginOptionsResponse;
  }

  /** Puts `email` on the waitlist (sign-ups closed); resolves with an error message, or null. */
  async joinWaitlist(email: string, captchaToken: string): Promise<string | null> {
    try {
      await this.api.joinWaitlist({ email, captchaToken });
      return null;
    } catch (err) {
      return errorMessage(err);
    }
  }

  /**
   * The signed-in caller, or null when this sends the browser to the login
   * page instead (no session, or a user without a verified email).
   */
  async requireUser(): Promise<MeResponse | null> {
    try {
      const me = await this.api.me();
      // Rolls a remembered session forward; the API itself never refreshes sessions.
      if (!me.devMode) void this.hasSession().catch(() => undefined);
      return me;
    } catch (err) {
      if (hasCode(err, 'unauthorized')) {
        location.replace(loginUrl(this.paths.login, { returnTo: this.currentPage() }));
        return null;
      }
      if (err instanceof ApiError && err.status === 403) {
        await this.client.signOut().catch(() => undefined);
        location.replace(
          loginUrl(this.paths.login, { returnTo: this.currentPage(), error: 'not_allowed' }),
        );
        return null;
      }
      throw err;
    }
  }

  /** This page as a return target; null on home, where a sign-in lands anyway. */
  private currentPage(): string | null {
    const here = `${location.pathname}${location.search}${location.hash}`;
    return here === this.paths.home ? null : here;
  }

  /**
   * Where a sign-in started on this login page lands: its `returnTo` when that
   * is a path on this site (`safeReturnPath`), else home.
   */
  signInDestination(): string {
    const requested = new URLSearchParams(location.search).get(RETURN_TO_PARAM);
    return safeReturnPath(requested) ?? this.paths.home;
  }

  /** This login page again, keeping its return target, for a sign-in that fails. */
  private loginAgain(): string {
    const destination = this.signInDestination();
    const returnTo = destination === this.paths.home ? null : destination;
    return loginUrl(this.paths.login, { returnTo });
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
    document.cookie = `${REMEMBER_COOKIE}=${remember ? '1' : '0'}; Path=${AUTH_BASE_PATH}; Max-Age=${REMEMBER_COOKIE_SECONDS}; SameSite=Lax${secure}`;
  }

  // ---- Sign-in. Each resolves with an error message, or navigates away on success.

  async signInSocial(provider: SocialProvider, remember: boolean): Promise<string | null> {
    this.setRemember(remember);
    // On success the client follows the provider's redirect itself.
    const { error } = await this.client.signIn.social({
      provider,
      callbackURL: this.signInDestination(),
      errorCallbackURL: this.loginAgain(),
    });
    return error ? messageFor(error) : null;
  }

  async sendMagicLink(
    email: string,
    captchaToken: string,
    remember: boolean,
  ): Promise<string | null> {
    this.setRemember(remember);
    // Better Auth's link verify decodes its callback URLs once more than the
    // link encoded them; escaping each `%` here cancels that, so a target
    // whose query holds `%26` or `%23` arrives unchanged.
    const { error } = await this.client.signIn.magicLink(
      {
        email,
        callbackURL: this.signInDestination().replaceAll('%', '%25'),
        errorCallbackURL: this.loginAgain().replaceAll('%', '%25'),
      },
      { headers: { 'x-captcha-response': captchaToken } },
    );
    return error ? messageFor(error) : null;
  }

  /**
   * Signs in with the 6-digit code from the magic-link email, for when the
   * email is open on another device. Resolves with why it failed, or
   * navigates away on success.
   */
  async signInWithCode(email: string, code: string, remember: boolean): Promise<CodeError | null> {
    this.setRemember(remember);
    const { error } = await this.client.signIn.emailOtp({ email, otp: code });
    if (error) return codeErrorMessage(error);
    location.assign(this.signInDestination());
    return null;
  }

  /** `autoFill`: conditional UI, i.e. offer passkeys in the email field's autofill. */
  async signInPasskey(remember: boolean, autoFill = false): Promise<string | null> {
    this.setRemember(remember);
    const res = await this.client.signIn.passkey({ autoFill });
    if (res?.error) return autoFill ? null : messageFor(res.error);
    location.assign(this.signInDestination());
    return null;
  }

  /**
   * Forgets the user's provider keys (an HttpOnly cookie, so only the server
   * can), then ends the session. Sign-out clears the keys too; forgetting
   * them first means a sign-out that fails leaves none behind either.
   */
  async signOut(): Promise<void> {
    await this.api.forgetKey().catch(() => undefined);
    await this.client.signOut();
    location.assign(this.paths.login);
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

/** Why a code didn't sign in; `spent` when only a new email brings one that works. */
export interface CodeError {
  text: string;
  spent: boolean;
}

/** A code sign-in's error (Better Auth's email-OTP codes) for the login page. */
export function codeErrorMessage(error: {
  message?: string | undefined;
  status?: number;
  code?: string | undefined;
}): CodeError {
  switch (error.code) {
    case 'INVALID_OTP':
      return { text: "That code isn't right. Check the email and try again.", spent: false };
    case 'OTP_EXPIRED':
      return { text: 'That code has expired.', spent: true };
    case 'TOO_MANY_ATTEMPTS':
      return { text: 'Too many wrong tries for that code.', spent: true };
    default:
      return { text: messageFor(error), spent: false };
  }
}

/** Login-page messages for `?error=` codes from OAuth and magic-link redirects. */
export function loginErrorMessage(code: string | null, brand = 'Tangent'): string | null {
  if (!code) return null;
  switch (code) {
    case 'unable_to_create_user':
    case 'not_allowed':
      return `${brand} needs a verified email address. Verify it with your provider, or sign in with an email link.`;
    case 'INVALID_TOKEN':
    case 'EXPIRED_TOKEN':
    case 'ATTEMPTS_EXCEEDED':
      return 'That sign-in link has expired or was already used. Request a new one.';
    case 'access_denied':
      return 'Sign-in was cancelled.';
    case SIGNUPS_CLOSED:
      return signupsClosedMessage(brand);
    default:
      return 'Sign-in failed. Please try again.';
  }
}
