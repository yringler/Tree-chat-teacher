import type { ProviderConfig } from '@tangent/shared';
import { abortable, getFetch, resolveConfigHeaders, stripTrailingSlash } from './internal.js';
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
 * (Anthropic) or `GET {baseUrl}/models` (OpenAI-compatible). The key is only
 * put in the auth header; nothing about it is logged or returned.
 */
export async function verifyApiKey(
  config: ProviderConfig,
  apiKey: string,
  env: ProviderEnv,
): Promise<KeyCheck> {
  const resolved = resolveConfigHeaders(config, env);
  if (resolved.missing !== undefined) return 'unverified';
  const headers = resolved.headers;
  let url: string;
  switch (config.kind) {
    case 'anthropic':
      url = `${stripTrailingSlash(config.baseUrl ?? 'https://api.anthropic.com')}/v1/models?limit=1`;
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      break;
    case 'openai-compatible':
      url = `${stripTrailingSlash(config.baseUrl ?? 'https://api.openai.com/v1')}/models`;
      headers['authorization'] = `Bearer ${apiKey}`;
      break;
    default:
      return 'unverified';
  }
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
