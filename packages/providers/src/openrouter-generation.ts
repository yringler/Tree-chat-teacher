import { isRecord, redact } from './internal.js';

const GENERATION_URL = 'https://openrouter.ai/api/v1/generation';

/** What OpenRouter reports for a finished (or cancelled) generation. */
export interface GenerationCost {
  /** `data.total_cost`, USD. */
  costUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cancelled: boolean;
  /** `data.num_search_results`: web search results the generation fetched (grounding). */
  numSearchResults: number | null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * `GET https://openrouter.ai/api/v1/generation?id=` with a Bearer key.
 * Resolves null when the generation is not (yet) available (404); throws on
 * other non-2xx responses, network failures and malformed bodies. Error
 * messages never contain the key.
 */
export async function fetchOpenRouterGeneration(
  id: string,
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<GenerationCost | null> {
  const doFetch = fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const secrets = [apiKey];
  const fail = (message: string): Error => new Error(truncate(redact(message, secrets)));

  let res: Response;
  try {
    res = await doFetch(`${GENERATION_URL}?id=${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
  } catch (e) {
    throw fail(`OpenRouter generation lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }

  let text = '';
  try {
    text = await res.text();
  } catch (e) {
    if (res.ok) throw fail(`OpenRouter generation lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    const detail = text.trim();
    throw fail(`OpenRouter generation lookup failed: HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw fail('OpenRouter generation lookup failed: response is not JSON');
  }
  const data = isRecord(body) ? body['data'] : undefined;
  const costUsd = isRecord(data) ? numOrNull(data['total_cost']) : null;
  if (!isRecord(data) || costUsd === null) {
    throw fail('OpenRouter generation lookup failed: response has no data.total_cost');
  }
  return {
    costUsd,
    inputTokens: numOrNull(data['native_tokens_prompt']),
    outputTokens: numOrNull(data['native_tokens_completion']),
    cancelled: data['cancelled'] === true,
    numSearchResults: numOrNull(data['num_search_results']),
  };
}
