import { DomainError, ValidationError } from '@tangent/core';
import { acceptsUserKey, verifyApiKey } from '@tangent/providers';
import {
  forgetKeyRequestSchema,
  LEARN_KEY_PROVIDER,
  saveKeyRequestSchema,
  type KeyStatusResponse,
  type ProviderConfig,
} from '@tangent/shared';
import { Hono } from 'hono';
import { enforceRateLimit, sameOriginOnly } from '../byok/guard.js';
import {
  clearKeyCookie,
  freshExpiry,
  keySecret,
  keyShapeProblem,
  KeyTooLargeError,
  readKeys,
  writeKeys,
} from '../byok/keys.js';
import type { AppBindings, AppContext } from '../env.js';
import { validateJson } from '../http/errors.js';
import { providerConfigs, providerEnv } from '../services.js';
import { simpleProviderConfig } from '../simple-mode.js';

/**
 * Bring-your-own-key management, mounted at /api/key. No route ever returns
 * any part of a key; the key is only accepted (POST) and then lives in the
 * sealed HttpOnly cookie. Both apps share the one cookie: Learn mode (simple)
 * stores and uses only the OpenRouter entry (LEARN_KEY_PROVIDER), checked
 * against its own provider config, so the same key works in both apps.
 */
export function keyRoutes(): Hono<AppBindings> {
  const r = new Hono<AppBindings>();
  r.use('*', sameOriginOnly);
  r.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  r.get('/status', async (c) => {
    const keys = await readKeys(c);
    // An unreadable cookie (rotated secret, expired, tampered) is dropped so the UI asks again.
    if (keys.state === 'invalid') clearKeyCookie(c);
    const providers = keys.state === 'ok' ? Object.keys(keys.keys) : [];
    return c.json({
      enabled: keySecret(c.env) !== null,
      hasKey: providers.length > 0,
      providers,
    } satisfies KeyStatusResponse);
  });

  r.post('/', validateJson(saveKeyRequestSchema), async (c) => {
    requireEnabled(c);
    const { provider, apiKey } = c.req.valid('json');
    const config = keyConfig(c, provider);
    if (!config || !acceptsUserKey(config))
      throw new ValidationError(`Unknown provider "${provider}"`);
    const problem = keyShapeProblem(config, apiKey);
    if (problem) throw new ValidationError(problem);

    const current = await readKeys(c);
    // The verification call hits the provider; limit it per account.
    await enforceRateLimit(c, null, 'key');

    // One cheap, unbilled call to confirm the key works. Only an explicit
    // 401/403 rejects it; an unreachable provider shouldn't block saving.
    if ((await verifyApiKey(config, apiKey, providerEnv(c.env))) === 'rejected') {
      throw new ValidationError(`${config.label} rejected this API key`);
    }

    const keys = current.state === 'ok' ? { ...current.keys } : {};
    keys[provider] = apiKey;
    try {
      await writeKeys(c, keys, freshExpiry());
    } catch (err) {
      if (err instanceof KeyTooLargeError) throw new ValidationError(err.message);
      throw err;
    }
    return c.body(null, 204);
  });

  r.delete('/', validateJson(forgetKeyRequestSchema), async (c) => {
    const { provider } = c.req.valid('json');
    const current = await readKeys(c);
    if (!provider || current.state !== 'ok') {
      clearKeyCookie(c);
      return c.body(null, 204);
    }
    const keys = Object.fromEntries(Object.entries(current.keys).filter(([id]) => id !== provider));
    // Keep the original expiry: forgetting one key must not extend the others.
    await writeKeys(c, keys, current.exp);
    return c.body(null, 204);
  });

  return r;
}

/** The provider config a key for `provider` is checked against, in the request's mode. */
function keyConfig(c: AppContext, provider: string): ProviderConfig | undefined {
  if (c.var.account.mode === 'simple') {
    return provider === LEARN_KEY_PROVIDER ? simpleProviderConfig(c.env) : undefined;
  }
  return providerConfigs(c.env).find((p) => p.id === provider);
}

function requireEnabled(c: AppContext): void {
  if (!keySecret(c.env)) {
    throw new DomainError('bad_request', 'Storing your own API key is not enabled on this server');
  }
}
