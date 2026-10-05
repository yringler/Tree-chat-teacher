import type { Context } from 'hono';
import { appConfig } from '../config.js';
import type { AppBindings, AppEnv } from '../env.js';
import { apiError } from '../http/errors.js';
import { sharingEnabled } from '../services.js';

/**
 * Whether a "featured learning" wall could be offered at all: its flag
 * (`FEATURED_CONVERSATIONS_ENABLED`, off) and public sharing, since featuring
 * a conversation is publishing user content, held back until a DMCA agent is
 * registered (`DMCA_AGENT_REGISTERED`). Nothing reads it yet: the wall is a
 * stub (docs/DEFERRED.md), so `/api/featured/*` is 404 either way.
 */
export function featuredEnabled(env: AppEnv): boolean {
  return appConfig(env).flags.featuredConversationsEnabled && sharingEnabled(env);
}

/**
 * `/api/featured` and everything under it, every method: 404 `not_found`,
 * like a route that doesn't exist, flag on or off. Registered before the
 * session middleware, so the answer is the same signed in or not. No table,
 * column or UI exists for featured conversations, so nothing is collected.
 */
export function featuredRoute(c: Context<AppBindings>): Response {
  return apiError(c, 'not_found', 'Route not found');
}
