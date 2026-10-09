// The caller's ChatService and key cookie, as the /api route modules build them.
import type { ChatService } from '@tangent/core';
import { requireReadableKeys, type UserKeys } from '../byok/keys.js';
import { callPayer, type AppContext } from '../env.js';
import { chatService } from '../registries.js';

/** The user's provider keys, opened. */
export type OpenKeys = Extract<UserKeys, { state: 'ok' }>;

/**
 * The caller's ChatService. `keys` are the user's own provider keys (unused
 * by Learn on credit or the pool); the usage meter of the built-in provider
 * defers its work to the request's `waitUntil`. `generating`: the service
 * will call a model, so a pool-funded account gets the pool's restrictions;
 * build it after `assertCanGenerate`, which settles who pays.
 */
export function chatOf(
  c: AppContext,
  keys: OpenKeys | null = null,
  generating = false,
): ChatService {
  return chatService(c.env, c.var.account, {
    ...(keys ? { apiKeys: keys.keys } : {}),
    defer: (p) => c.executionCtx.waitUntil(p),
    generating,
  });
}

/**
 * The user's key cookie for routes that call a provider. Learn on credit
 * never uses the user's own keys, so the cookie (if any) is not even read;
 * power always reads it, for its other providers.
 */
export async function keysOf(c: AppContext): Promise<OpenKeys | null> {
  return callPayer(c.var.account, 'own-key') === 'own-key' ? requireReadableKeys(c) : null;
}
