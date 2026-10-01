// Wave 1 stub (foundation). Implemented in wave 2 by the `providers` agent.

/** What OpenRouter reports for a finished (or cancelled) generation. */
export interface GenerationCost {
  /** `data.total_cost`, USD. */
  costUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cancelled: boolean;
}

/**
 * `GET https://openrouter.ai/api/v1/generation?id=` with a Bearer key.
 * Resolves null when the generation is not (yet) available (404); throws on
 * other non-2xx responses.
 */
export function fetchOpenRouterGeneration(
  _id: string,
  _apiKey: string,
  _fetchImpl?: typeof fetch,
): Promise<GenerationCost | null> {
  throw new Error('not implemented');
}
