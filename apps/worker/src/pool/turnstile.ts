// Server-side Cloudflare Turnstile check (Siteverify) for the open pool's
// human check: the interstitial after a first OAuth sign-in and
// `POST /api/pool/verify`. Magic-link sign-ins are checked by Better Auth's
// captcha plugin instead (auth/auth.ts). Fails closed: no secret, a network
// error or an unexpected answer all mean "not verified".
import type { AppEnv } from '../env.js';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Longest token Turnstile issues (its docs: 2048 characters). */
export const TURNSTILE_TOKEN_MAX = 2048;
const SITEVERIFY_TIMEOUT_MS = 5_000;

interface SiteverifyResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
}

export interface TurnstileCheck {
  /** The widget's `action`, checked when Siteverify reports one. */
  action?: string;
  /** The hostname the token must be issued for; null = not pinned (local dev, Turnstile's test keys). */
  hostname: string | null;
}

/** True when both halves of Turnstile are configured (a widget can be shown and checked). */
export function turnstileConfigured(env: AppEnv): boolean {
  return !!env.TURNSTILE_SECRET_KEY?.trim() && !!env.TURNSTILE_SITE_KEY?.trim();
}

/** Verifies a Turnstile token with Siteverify. False on anything but a clear pass. */
export async function verifyTurnstile(
  env: AppEnv,
  token: string,
  ip: string | null,
  check: TurnstileCheck,
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret || !token || token.length > TURNSTILE_TOKEN_MAX) return false;
  let body: SiteverifyResponse;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    body = await res.json();
  } catch (err) {
    console.error('Turnstile Siteverify failed', err);
    return false;
  }
  if (body.success !== true) return false;
  if (check.hostname !== null && body.hostname !== check.hostname) return false;
  if (check.action !== undefined && body.action !== undefined && body.action !== check.action)
    return false;
  return true;
}

/**
 * The interstitial that runs Turnstile after a first OAuth sign-in
 * (http/verify-page.ts): magic links are checked when requested, OAuth
 * providers aren't, so their first sign-in lands here before the app.
 */
export const VERIFY_PAGE_PATH = '/verify';
/** The Turnstile widget's action on the interstitial and in `POST /api/pool/verify`. */
export const TURNSTILE_ACTION = 'pool-verify';

/**
 * A same-origin path to continue to after the interstitial: `raw` when it is
 * a path on this origin (an absolute URL is reduced to its path when its
 * origin is `origin`), else `/`. Never a protocol-relative `//host`.
 */
export function safeNextPath(raw: string | null | undefined, origin: string): string {
  if (!raw) return '/';
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return '/';
  }
  if (url.origin !== origin) return '/';
  const path = `${url.pathname}${url.search}${url.hash}`;
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') ? path : '/';
}

/** The interstitial's URL, continuing to `next` (a same-origin path). */
export function verifyPageUrl(next: string): string {
  return `${VERIFY_PAGE_PATH}?next=${encodeURIComponent(next)}`;
}
