// Which hosted backends a built-in call runs on: its chain, the backends
// `BUILT_IN_BACKENDS` lists that hold their key and can serve its logical
// model, in that order. OpenRouter serves every model, so a call no listed
// backend can serve runs there. A `BUILT_IN_PROVIDER` override replaces
// OpenRouter's endpoint and is then the only backend: every call runs on it,
// with OpenRouter's facts (a fake stands in for OpenRouter in the tests).
import { HOSTED_BACKEND_IDS, appConfig } from '../config.js';
import type { AppEnv } from '../env.js';
import { anthropicBackend } from './anthropic.js';
import type { HostedBackend, HostedBackendId } from './backend.js';
import { openRouterBackend } from './openrouter.js';

const BACKENDS: Record<HostedBackendId, HostedBackend> = {
  openrouter: openRouterBackend,
  anthropic: anthropicBackend,
};

/** The backend of `id` (a usage row's, a config's). */
export function hostedBackend(id: HostedBackendId): HostedBackend {
  return BACKENDS[id];
}

/**
 * SQL: a `usage_events` row whose generation id can be looked up, by its
 * `backend`: a backend with a lookup, or none recorded (rows from before
 * backends were). Other rows settle as calls without a generation id.
 */
export const LOOKUP_ROW_SQL = `(backend IS NULL OR backend IN (${HOSTED_BACKEND_IDS.filter(
  (id) => BACKENDS[id].fetchGeneration !== null,
)
  .map((id) => `'${id}'`)
  .join(', ')}))`;

/** One backend a built-in call can run on, and its id of the call's logical model. */
export interface HostedRoute {
  backend: HostedBackend;
  model: string;
}

/** The backends a built-in call on `logical` runs on, first choice first (never empty). */
export function hostedChain(env: AppEnv, logical: string): HostedRoute[] {
  const { builtIn } = appConfig(env);
  if (builtIn.provider) return [{ backend: openRouterBackend, model: logical }];
  const chain = builtIn.backends.flatMap((id) => {
    const backend = BACKENDS[id];
    const model = backend.modelId(logical);
    return model !== null && backend.apiKey(env) !== null ? [{ backend, model }] : [];
  });
  // Keyless too: the built-in provider then reports itself unavailable, as without backends.
  return chain.length > 0 ? chain : [{ backend: openRouterBackend, model: logical }];
}

/** Where a built-in call on `logical` is sent, as its usage row stores it. */
export interface UsageBackend {
  /** `usage_events.backend`: the first backend of its chain. */
  backend: HostedBackendId;
  /** `usage_events.backend_model`: that backend's id of the model. */
  backendModel: string;
}

/** The `UsageBackend` of a built-in call on `logical`. */
export function usageBackend(env: AppEnv, logical: string): UsageBackend {
  const [first] = hostedChain(env, logical);
  return { backend: first!.backend.id, backendModel: first!.model };
}
