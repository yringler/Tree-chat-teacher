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
 * (`OPENROUTER_SIMPLE_API_KEY`), which Tangent credit and the open pool
 * pay for, and the endpoint Learn runs on whoever pays. It is the same id as
 * the user's own OpenRouter (`LEARN_KEY_PROVIDER`): the funding, not the id,
 * says whose key a call uses.
 */
export const BUILT_IN_PROVIDER_ID = 'openrouter';

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

/** The inverse of `routeKey`. */
export function parseRouteKey(key: string): ProviderRoute {
  if (key.endsWith(CREDIT_SUFFIX))
    return { providerId: key.slice(0, -CREDIT_SUFFIX.length), funding: 'credit' };
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
