import type { LlmProvider, ProviderConfig } from '@tangent/shared';
import type { ProviderEnv } from './registry.js';

/**
 * Deterministic provider for tests and keyless local dev.
 *
 * Reply text, unless overridden:
 *   `Fake reply (${model}) to ${messages.length} message(s): "${lastUser.slice(0, 80)}"`
 * where lastUser is the content of the last user message.
 *
 * options (all optional):
 * - responses: Record<string, string> — if the last user message contains a
 *   key, reply with its value (first match in insertion order);
 * - chunkSize: number (default 8) — characters per `delta`;
 * - delayMs: number (default 0) — await between deltas (to test abort);
 * - failWith: ProviderErrorCode — emit this error after the first delta;
 * - maxContextTokens / maxOutputTokens via config.
 * Usage: inputTokens = ceil(total input chars / 4), outputTokens = ceil(reply chars / 4),
 * emitted once before `done`. countTokens returns the same inputTokens figure.
 */
export function createFakeProvider(config: ProviderConfig, env: ProviderEnv): LlmProvider {
  void config;
  void env;
  throw new Error('not implemented');
}
