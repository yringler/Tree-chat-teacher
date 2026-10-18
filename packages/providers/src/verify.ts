import type { ProviderConfig } from '@tangent/shared';
import { abortable, getFetch, resolveConfigHeaders } from './internal.js';
import { PROVIDER_KINDS } from './kinds.js';
import type { ProviderEnv } from './registry.js';

/**
 * `valid`: the provider accepted the key. `rejected`: it answered 401/403.
 * `unverified`: anything else (network error, 5xx, timeout, no cheap
 * endpoint for this kind); the caller decides whether to accept the key.
 */
export type KeyCheck = 'valid' | 'rejected' | 'unverified';

const TIMEOUT_MS = 8000;

/**
 * One cheap, non-billed request that needs a valid key: `GET /v1/models`
 * (Anthropic), `GET {baseUrl}/key` (OpenRouter) or `GET {baseUrl}/models`
 * (another OpenAI-compatible endpoint). The key is only
 * put in the auth header; nothing about it is logged or returned.
 */
export async function verifyApiKey(
  config: ProviderConfig,
  apiKey: string,
  env: ProviderEnv,
): Promise<KeyCheck> {
  const resolved = resolveConfigHeaders(config, env);
  if (resolved.missing !== undefined) return 'unverified';
  const request = PROVIDER_KINDS[config.kind].verifyRequest(config.baseUrl, apiKey);
  if (request === null) return 'unverified';
  const { url } = request;
  const headers = { ...resolved.headers, ...request.headers };
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await abortable(getFetch(env)(url, { method: 'GET', headers, signal }), signal);
    // Only the status matters; release the body without reading it.
    void res.body?.cancel().catch(() => undefined);
    if (res.ok) return 'valid';
    if (res.status === 401 || res.status === 403) return 'rejected';
    return 'unverified';
  } catch {
    return 'unverified';
  }
}
