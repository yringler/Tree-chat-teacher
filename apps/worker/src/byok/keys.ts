import { KeyRequiredError } from '@tangent/core';
import type { ProviderConfig } from '@tangent/shared';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { appConfig } from '../config.js';
import type { MiddlewareHandler } from 'hono';
import type { AppBindings, AppContext, AppEnv } from '../env.js';
import { open, seal, UnsealError } from './seal.js';

/**
 * Bring-your-own-key storage. The user's provider keys live only in the
 * browser, as one AES-GCM-sealed HttpOnly cookie (`__Host-llmkey`). The
 * Worker opens it per request and never persists or logs the plaintext.
 *
 * One cookie holds a map of provider id → key rather than one cookie per
 * provider: a conversation can switch providers per branch, and summaries or
 * titles may run on a different provider than the branch, so every
 * provider-calling request needs the whole set. One cookie means one decrypt,
 * atomic updates, and one name to clear on "forget".
 *
 * The cookie is the signed-in user's: it seals their user id, a cookie
 * sealed for anyone else counts as unreadable (and is cleared), and signing
 * out clears it (auth/auth.ts), so on a shared browser the next user never
 * generates on the previous one's keys.
 *
 * The expiry slides: using the keys reseals the cookie for another
 * KEY_TTL_SECONDS once it is a day old, so the keys lapse after a week unused
 * rather than a week after they were saved, and most requests set no cookie.
 */

/** Cookie name without the `__Host-` prefix, which hono adds (and enforces Secure + Path=/). */
const COOKIE = 'llmkey';
export const KEY_COOKIE_NAME = `__Host-${COOKIE}`;
export const KEY_TTL_SECONDS = 7 * 24 * 60 * 60;
const RENEW_AFTER_SECONDS = 24 * 60 * 60;
/** Stay under the ~4096-byte per-cookie limit browsers enforce. */
const MAX_SEALED_LENGTH = 3800;

const payloadSchema = z.object({
  keys: z.record(z.string().min(1).max(64), z.string().min(1).max(512)),
  /** Unix seconds. Enforced server-side too, so a replayed old cookie stops working. */
  exp: z.number().int(),
  /** The user the keys belong to (null: the dev bypass, which has none). */
  uid: z.string().min(1).nullable(),
});
type KeyPayload = z.infer<typeof payloadSchema>;

export type UserKeys =
  | { state: 'none' }
  /** A cookie was sent but can't be used: tampered, expired, malformed, or sealed with a rotated secret. */
  | { state: 'invalid' }
  | { state: 'ok'; keys: Readonly<Record<string, string>>; exp: number; sealed: string };

/** The configured secret, or null when bring-your-own-key is disabled. */
export function keySecret(env: AppEnv): string | null {
  return appConfig(env).power.keyEncryptionSecret;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Opens a sealed key cookie value for `userId`: sealed for another user (or
 * none) it is `invalid`. Never throws for a bad value (only for a broken
 * server secret).
 */
export async function openKeys(
  sealed: string | undefined,
  env: AppEnv,
  userId: string | null,
): Promise<UserKeys> {
  if (!sealed) return { state: 'none' };
  const secret = keySecret(env);
  if (!secret) return { state: 'invalid' };
  let payload: KeyPayload;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(await open(sealed, secret)));
    if (!parsed.success) return { state: 'invalid' };
    payload = parsed.data;
  } catch (err) {
    if (err instanceof UnsealError || err instanceof SyntaxError) return { state: 'invalid' };
    throw err;
  }
  if (payload.exp <= nowSeconds() || payload.uid !== userId) return { state: 'invalid' };
  return { state: 'ok', keys: payload.keys, exp: payload.exp, sealed };
}

/** The request's key cookie, opened for its signed-in user. */
export function readKeys(c: AppContext): Promise<UserKeys> {
  return openKeys(getCookie(c, COOKIE, 'host'), c.env, c.var.identity.userId);
}

/**
 * For routes that call a provider. Returns the user's keys (null when no
 * cookie was sent: server secrets apply). An unreadable cookie is cleared
 * and answered with 401 key_required so the UI asks for the key again.
 */
export async function requireReadableKeys(
  c: AppContext,
): Promise<Extract<UserKeys, { state: 'ok' }> | null> {
  const keys = await readKeys(c);
  if (keys.state === 'ok') {
    renewKeys(c, keys);
    return keys;
  }
  if (keys.state === 'invalid') {
    clearKeyCookie(c);
    throw new KeyRequiredError(
      'Your stored API key could not be read (it expired or was reset). Enter it again.',
    );
  }
  return null;
}

/** Seals `keys` into the cookie for the signed-in user (or clears it when empty). */
export async function writeKeys(
  c: AppContext,
  keys: Record<string, string>,
  exp: number,
): Promise<void> {
  if (Object.keys(keys).length === 0) {
    clearKeyCookie(c);
    return;
  }
  const secret = keySecret(c.env);
  if (!secret) throw new Error('writeKeys called without KEY_ENCRYPTION_SECRET');
  const payload: KeyPayload = { keys, exp, uid: c.var.identity.userId };
  const sealed = await seal(JSON.stringify(payload), secret);
  if (sealed.length > MAX_SEALED_LENGTH) throw new KeyTooLargeError();
  setCookie(c, COOKIE, sealed, {
    prefix: 'host',
    ...KEY_COOKIE_ATTRIBUTES,
    maxAge: Math.max(0, exp - nowSeconds()),
  });
}

export function freshExpiry(): number {
  return nowSeconds() + KEY_TTL_SECONDS;
}

/**
 * Marks readable keys for resealing with a fresh expiry once the cookie is
 * more than a day old; `keyRenewal` writes the cookie after the handler.
 */
export function renewKeys(c: AppContext, keys: Extract<UserKeys, { state: 'ok' }>): void {
  if (keys.exp - nowSeconds() > KEY_TTL_SECONDS - RENEW_AFTER_SECONDS) return;
  c.set('renewKeys', keys.keys);
}

/**
 * Writes a renewal marked by `renewKeys` onto the finished response. It runs
 * after the handler because a route that returns a Durable Object's response
 * as is drops cookies set on the context before it.
 */
export const keyRenewal: MiddlewareHandler<AppBindings> = async (c, next) => {
  await next();
  const keys = c.get('renewKeys');
  if (keys && !c.error) await writeKeys(c, { ...keys }, freshExpiry());
};

/** The cookie's attributes, shared by every write and by sign-out's clear (auth/auth.ts). */
export const KEY_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: true,
  sameSite: 'Strict',
  path: '/',
} as const;

export function clearKeyCookie(c: AppContext): void {
  deleteCookie(c, COOKIE, { prefix: 'host', ...KEY_COOKIE_ATTRIBUTES });
}

export class KeyTooLargeError extends Error {
  constructor() {
    super('Too many or too long API keys to store in one cookie');
    this.name = 'KeyTooLargeError';
  }
}

/**
 * Cheap offline shape check before anything is sealed or sent upstream.
 * Returns a user-facing problem, or null when the key looks plausible.
 */
export function keyShapeProblem(config: ProviderConfig, apiKey: string): string | null {
  if (!/^[\x21-\x7e]+$/.test(apiKey)) return 'An API key has no spaces or special characters';
  if (apiKey.length < 20) return 'That is too short to be an API key';
  if (config.kind === 'anthropic' && !config.baseUrl && !apiKey.startsWith('sk-ant-')) {
    return 'Anthropic API keys start with "sk-ant-"';
  }
  if (config.kind === 'openai-compatible' && !config.baseUrl && !apiKey.startsWith('sk-')) {
    return 'OpenAI API keys start with "sk-"';
  }
  return null;
}
