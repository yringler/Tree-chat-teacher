import type { BranchFunding } from './domain.js';

/**
 * A provider id names an endpoint (`openrouter`, `anthropic`, `openai`, …)
 * and means the same in both apps; who pays for a call is its funding,
 * decided separately (docs/DECISIONS.md, "Funding apart from the provider").
 * A route is the pair: which endpoint, paid how.
 */
export interface ProviderRoute {
  providerId: string;
  funding: BranchFunding;
}

/**
 * The endpoint of the built-in provider: OpenRouter on the operator's key
 * (`OPENROUTER_SIMPLE_API_KEY`), which Tangent credit and the community pool
 * pay for, and the endpoint Learn runs on whoever pays. It is the same id as
 * the user's own OpenRouter (`LEARN_KEY_PROVIDER`): the funding, not the id,
 * says whose key a call uses.
 */
export const BUILT_IN_PROVIDER_ID = 'openrouter';

/**
 * The built-in provider's id before funding was split from it (migration
 * 0020): `tangent` meant "OpenRouter, paid with Tangent credit" in power mode
 * and "OpenRouter, paid per request" in Learn. Requests from clients built
 * before the change may still name it; `fromLegacyRoute` reads it as
 * `openrouter` on credit (Learn ignores a branch's funding, so this is what it
 * meant in either app). Stored data and backups are mapped by their own rules.
 */
export const LEGACY_BUILT_IN_PROVIDER_ID = 'tangent';

/**
 * A request naming the legacy `tangent` id, read as the built-in endpoint on
 * Tangent credit (unless it names its funding itself); any other request is
 * returned unchanged.
 */
export function fromLegacyRoute<
  T extends { providerId?: string | undefined; funding?: BranchFunding | undefined },
>(request: T): T {
  if (request.providerId !== LEGACY_BUILT_IN_PROVIDER_ID) return request;
  return { ...request, providerId: BUILT_IN_PROVIDER_ID, funding: request.funding ?? 'credit' };
}

/** Separator of `routeKey`; provider ids are config ids and never contain it. */
const CREDIT_SUFFIX = '@credit';

/**
 * One string per route, for UI pickers that list routes in one select: the
 * provider id for `own-key` (so a plain provider id is its own key), and
 * `<providerId>@credit` for Tangent credit. Never sent to the server.
 */
export function routeKey(route: {
  providerId: string;
  funding?: BranchFunding | undefined;
}): string {
  return route.funding === 'credit' ? `${route.providerId}${CREDIT_SUFFIX}` : route.providerId;
}

/** The inverse of `routeKey`; the legacy `tangent` id reads as the built-in endpoint on credit. */
export function parseRouteKey(key: string): ProviderRoute {
  if (key.endsWith(CREDIT_SUFFIX))
    return { providerId: key.slice(0, -CREDIT_SUFFIX.length), funding: 'credit' };
  if (key === LEGACY_BUILT_IN_PROVIDER_ID)
    return { providerId: BUILT_IN_PROVIDER_ID, funding: 'credit' };
  return { providerId: key, funding: 'own-key' };
}

/** True when two routes name the same endpoint paid the same way (a missing funding is `own-key`). */
export function sameRoute(
  a: { providerId: string; funding?: BranchFunding | undefined },
  b: { providerId: string; funding?: BranchFunding | undefined },
): boolean {
  return routeKey(a) === routeKey(b);
}

/** The `routeKey` of a `/api/providers` entry (its id and funding). */
export function providerRouteKey(p: { id: string; funding?: BranchFunding | undefined }): string {
  return routeKey({ providerId: p.id, funding: p.funding });
}
