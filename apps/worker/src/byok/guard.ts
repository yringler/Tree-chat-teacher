import { DomainError, KeyRequiredError, ValidationError } from '@tangent/core';
import { isModelAllowed, type ProviderRegistry } from '@tangent/shared';
import { createMiddleware } from 'hono/factory';
import { isMetered, type AppBindings, type AppContext } from '../env.js';
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
 * model must be allowed: one the provider config lists or, for an
 * `openModels` provider, any well-formed model id (`isModelAllowed`).
 * `userKeys: false` (the built-in provider on credit, which never uses the
 * user's key) reports a missing server key as a configuration problem rather
 * than asking for the user's key.
 */
export function assertGenerationAllowed(
  registry: ProviderRegistry,
  providerId: string,
  model: string,
  opts: { userKeys?: boolean } = {},
): void {
  const info = registry.list().find((p) => p.id === providerId);
  if (!info) throw new ValidationError(`Unknown provider "${providerId}"`);
  if (!info.available) {
    if ((opts.userKeys ?? true) && info.acceptsUserKey && info.keySource !== 'user') {
      throw new KeyRequiredError(`Add your ${info.label} API key to continue this conversation.`);
    }
    throw new ValidationError(`${info.label} is not configured on this server`);
  }
  if (!isModelAllowed(info, model)) {
    throw new ValidationError(`Model "${model}" is not enabled for ${info.label}`);
  }
}

/**
 * Rate limit on requests that spend a user's key. `chat`: per key cookie, the
 * bucket being a hash of the sealed value (never of the plaintext key);
 * power requests on server keys (dev bypass only) are not limited here.
 * A call on the built-in provider (`providerId` metered, see `isMetered`)
 * spends the operator's key, so its `chat` bucket is the user's ledger
 * (`billing:<billingAccountId>`), shared by both apps. `key`: saving a key
 * makes a verification call upstream, limited per account (a fresh cookie
 * per save would otherwise reset the bucket).
 * A missing binding or a limiter failure lets the request through
 * (availability over strictness; the model allowlist and output cap still apply).
 */
export async function enforceRateLimit(
  c: AppContext,
  keys: UserKeys | null,
  scope: 'chat' | 'key',
  providerId?: string,
): Promise<void> {
  const limiter = (scope === 'chat' ? c.env.CHAT_RATE_LIMITER : c.env.KEY_RATE_LIMITER) as
    RateLimit | undefined;
  if (!limiter || typeof limiter.limit !== 'function') return;
  let who: string;
  if (scope === 'key') who = `account:${c.var.accountId}`;
  else if (providerId !== undefined && isMetered(c.var.account, providerId))
    who = `billing:${c.var.account.billingAccountId}`;
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
