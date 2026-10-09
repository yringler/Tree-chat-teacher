/**
 * The HTTP side the provider implementations share: one JSON POST with its
 * failures mapped to ProviderErrors, response numbers, and cited sources.
 */
import {
  CITATION_EXCERPT_MAX,
  CITATIONS_MAX,
  clip,
  isCitableUrl,
  type Citation,
} from '@tangent/shared';
import {
  ProviderFailure,
  abortable,
  errorFromResponse,
  networkError,
  providerError,
} from './internal.js';

/** A finite number from a response body, else undefined. */
export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * POSTs `body` as JSON and resolves with the 2xx response. Rejects with a
 * ProviderFailure that says how far the call got (`ProviderError.upstream`):
 * `not_sent` when the request never left (a connection failure), `rejected`
 * for a non-2xx response; with an AbortError when `signal` aborts, even if
 * the fetch ignores it.
 */
export async function postJson(
  doFetch: typeof fetch,
  url: string,
  init: { headers: Record<string, string>; body: unknown; signal?: AbortSignal | undefined },
  secrets: readonly string[],
): Promise<Response> {
  const { signal } = init;
  const request: RequestInit = {
    method: 'POST',
    headers: init.headers,
    body: JSON.stringify(init.body),
  };
  if (signal) request.signal = signal;
  let res: Response;
  try {
    res = await abortable(doFetch(url, request), signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ProviderFailure({ ...networkError(e, secrets), upstream: 'not_sent' });
  }
  if (!res.ok) {
    throw new ProviderFailure({
      ...(await errorFromResponse(res, signal, secrets)),
      upstream: 'rejected',
    });
  }
  return res;
}

/** `res`'s body for streaming; a 2xx without one failed after the upstream answered. */
export function streamBody(res: Response): ReadableStream<Uint8Array> {
  if (!res.body) {
    throw new ProviderFailure({
      ...providerError('network', 'Response has no body'),
      upstream: 'stream',
    });
  }
  return res.body;
}

const CITATION_TITLE_MAX = 500;

/**
 * Adds a source the reply cites to `into`: http(s) only, deduplicated by URL,
 * at most CITATIONS_MAX; the title trimmed, the cited text collapsed to one
 * line as the excerpt, each clipped. Returns true if it was added.
 */
export function addCitation(
  into: Map<string, Citation>,
  raw: { url: unknown; title: unknown; text: unknown },
): boolean {
  if (typeof raw.url !== 'string') return false;
  const url = raw.url.trim();
  if (!isCitableUrl(url) || into.has(url) || into.size >= CITATIONS_MAX) return false;
  const title =
    typeof raw.title === 'string' && raw.title.trim()
      ? clip(raw.title.trim(), CITATION_TITLE_MAX)
      : null;
  const text = typeof raw.text === 'string' ? raw.text.replace(/\s+/g, ' ').trim() : '';
  into.set(url, { url, title, excerpt: text ? clip(text, CITATION_EXCERPT_MAX) : null });
  return true;
}
