// The catalog of logical model ids: OpenRouter's model list. Prices and
// context windows are keyed by these ids and synced from that list
// (pool/model-prices.ts, model-windows.ts), whichever backend serves a call.
import { providerTraits } from '@tangent/providers';
import type { ProviderConfig } from '@tangent/shared';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FETCH_TIMEOUT_MS = 15_000;

/** Whether `config`'s model ids are catalog ids, so the synced prices and windows describe them. */
export function onCatalog(config: ProviderConfig): boolean {
  return providerTraits(config).catalog === 'openrouter';
}

/** `GET /api/v1/models` (public, no key), its body as JSON. Throws on network failure or non-2xx. */
export async function fetchModelsList(
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<unknown> {
  const res = await fetchImpl(OPENROUTER_MODELS_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`OpenRouter models list failed: HTTP ${res.status}`);
  }
  return res.json();
}
