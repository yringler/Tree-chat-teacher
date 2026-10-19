// Which hosted backends the built-in provider runs on. There is one,
// OpenRouter: every built-in call, usage row and generation lookup is its.
import type { AppEnv } from '../env.js';
import type { HostedBackend, HostedBackendId } from './backend.js';
import { openRouterBackend } from './openrouter.js';

const BACKENDS: Record<HostedBackendId, HostedBackend> = { openrouter: openRouterBackend };

/** The backend of `id` (a usage row's, a lookup's). */
export function hostedBackend(id: HostedBackendId): HostedBackend {
  return BACKENDS[id];
}

/** The backends that can serve built-in calls on `logical`, first choice first. */
export function backendsFor(_env: AppEnv, logical: string): HostedBackend[] {
  return [openRouterBackend].filter((b) => b.modelId(logical) !== null);
}
