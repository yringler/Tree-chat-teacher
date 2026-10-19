// A hosted backend: an API the built-in provider (Tangent credit and the open
// pool, on the operator's key) runs a call on. Branches store the provider id
// `openrouter` and a logical model id, the model's id in OpenRouter's catalog
// (catalog.ts); a backend maps that id to its own and says how a call on it is
// billed and reconciled. Prices stay keyed by the logical id. The fee of a
// search a backend bills outside a reported cost follows from its endpoint's
// kind (`unreportedSearchFeeMicros`), so it has no field of its own here.
import type { GenerationCost } from '@tangent/providers';
import type { ProviderConfig } from '@tangent/shared';
import type { HostedBackendId } from '../config.js';
import type { AppEnv } from '../env.js';

export type { HostedBackendId } from '../config.js';

/** The endpoint part of the built-in provider's config on a backend. */
export type HostedEndpoint = Pick<ProviderConfig, 'kind' | 'baseUrl' | 'apiKeySecret' | 'options'>;

/** The cost of a generation by id: null while not (yet) known; throws on other failures. */
export type GenerationLookup = (
  generationId: string,
  key: string,
  fetchImpl?: typeof fetch,
) => Promise<GenerationCost | null>;

export interface HostedBackend {
  readonly id: HostedBackendId;
  /** Where the built-in provider sends a call on this backend, and with which key secret. */
  config(): HostedEndpoint;
  /** The key the backend spends, or null when the deployment has none. */
  apiKey(env: AppEnv): string | null;
  /** The backend's id of a logical model; null when it can't serve it. */
  modelId(logical: string): string | null;
  /**
   * How a call's cost is known: `reported` by the backend with the stream
   * (or its generation lookup), or `tokens` × the logical model's price.
   */
  readonly cost: 'reported' | 'tokens';
  /** How a call's cost is looked up afterwards by its generation id; null where it can't be. */
  readonly fetchGeneration: GenerationLookup | null;
  /** The fee the pool grosses a price up by on this backend, unless the price entry sets its own. */
  feeBps(env: AppEnv): number;
}
