import type { LlmProvider, ProviderConfig } from '@tangent/shared';
import type { ProviderEnv } from './registry.js';

/**
 * Anthropic Messages API over raw fetch + SSE (POST {baseUrl}/v1/messages,
 * `anthropic-version: 2023-06-01`). Default baseUrl https://api.anthropic.com;
 * set baseUrl to an AI Gateway URL (…/{account}/{gateway}/anthropic) to route
 * through Cloudflare AI Gateway. Implements countTokens via
 * /v1/messages/count_tokens. Does not send `temperature` or assistant prefill.
 */
export function createAnthropicProvider(config: ProviderConfig, env: ProviderEnv): LlmProvider {
  void config;
  void env;
  throw new Error('not implemented');
}
