import { DomainError, ValidationError } from '@tangent/core';
import { acceptsUserKey, verifyApiKey } from '@tangent/providers';
import {
  forgetKeyRequestSchema,
  saveKeyRequestSchema,
  type KeyStatusResponse,
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

/**
 * Bring-your-own-key management, mounted at /api/key. No route ever returns
 * any part of a key; the key is only accepted (POST) and then lives in the
 * sealed HttpOnly cookie. Power accounts only: simple accounts always use
 * the operator's key and are billed for it.
 */
export function keyRoutes(): Hono<AppBindings> {
  const r = new Hono<AppBindings>();
  r.use('*', async (c, next) => {
    if (c.var.account.mode === 'simple') {
      throw new DomainError('forbidden', 'Your own API keys are not available in this app');
    }
    await next();
  });
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
    const config = providerConfigs(c.env).find((p) => p.id === provider);
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

function requireEnabled(c: AppContext): void {
  if (!keySecret(c.env)) {
    throw new DomainError('bad_request', 'Storing your own API key is not enabled on this server');
  }
}
