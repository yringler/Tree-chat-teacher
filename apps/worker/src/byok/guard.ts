import { DomainError, KeyRequiredError, ValidationError } from '@tangent/core';
import type { ProviderRegistry } from '@tangent/shared';
import { createMiddleware } from 'hono/factory';
import type { AppBindings, AppContext } from '../env.js';
import { fingerprint } from './seal.js';
import type { UserKeys } from './keys.js';

/**
 * Controls on the routes that spend the user's provider credit. An XSS on
 * the origin can ride the key cookie (it can't read it), so these routes are
 * where abuse is bounded: same-origin only, allow-listed models, a per-cookie
 * rate limit. Output tokens are capped server-side by ChatSettings and the
 * provider config; the client never chooses max_tokens or the model per
 * request (both come from the stored branch).
 */

/**
 * Rejects requests the browser marks as coming from another origin, including
 * a sibling subdomain (`same-site`), which SameSite=Strict alone does not
 * stop. Requests without Sec-Fetch-Site (non-browser clients) pass: they
 * can't carry the user's cookie without already having it.
 */
export const sameOriginOnly = createMiddleware<AppBindings>(async (c, next) => {
  const site = c.req.header('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new DomainError('forbidden', 'Cross-origin requests are not allowed');
  }
  await next();
});

/**
 * The branch's provider must have a key (the user's or the server's) and the
 * model must be one the provider config lists.
 */
export function assertGenerationAllowed(
  registry: ProviderRegistry,
  providerId: string,
  model: string,
): void {
  const info = registry.list().find((p) => p.id === providerId);
  if (!info) throw new ValidationError(`Unknown provider "${providerId}"`);
  if (!info.available) {
    if (info.acceptsUserKey && info.keySource !== 'user') {
      throw new KeyRequiredError(`Add your ${info.label} API key to continue this conversation.`);
    }
    throw new ValidationError(`${info.label} is not configured on this server`);
  }
  if (info.models.length > 0 && !info.models.some((m) => m.id === model)) {
    throw new ValidationError(`Model "${model}" is not enabled for ${info.label}`);
  }
}

/**
 * Rate limit on requests that spend a user's key. `chat`: per key cookie, the
 * bucket being a hash of the sealed value (never of the plaintext key);
 * requests on server keys are not limited here. `key`: saving a key makes a
 * verification call upstream, limited per account (a fresh cookie per save
 * would otherwise reset the bucket).
 * A missing binding or a limiter failure lets the request through
 * (availability over strictness; the model allowlist and output cap still apply).
 */
export async function enforceRateLimit(
  c: AppContext,
  keys: UserKeys | null,
  scope: 'chat' | 'key',
): Promise<void> {
  const limiter = (scope === 'chat' ? c.env.CHAT_RATE_LIMITER : c.env.KEY_RATE_LIMITER) as
    RateLimit | undefined;
  if (!limiter || typeof limiter.limit !== 'function') return;
  let who: string;
  if (scope === 'key') who = `account:${c.var.accountId}`;
  else if (keys?.state === 'ok') who = `cookie:${await fingerprint(keys.sealed)}`;
  else return;
  let success = true;
  try {
    ({ success } = await limiter.limit({ key: `${scope}:${who}` }));
  } catch (err) {
    console.warn(
      `${scope} rate limiter failed; allowing request`,
      err instanceof Error ? err.name : 'unknown',
    );
  }
  if (!success)
    throw new DomainError('rate_limited', 'Too many requests. Wait a minute and try again.');
}
