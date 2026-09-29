import type { LlmProvider, ProviderConfig } from '@tangent/shared';
import type { ProviderEnv } from './registry.js';

/**
 * OpenAI Chat Completions–compatible provider (OpenAI, OpenRouter, AI Gateway
 * compat endpoint, local servers). POST {baseUrl}/chat/completions with
 * `stream: true, stream_options: {include_usage: true}`. Default baseUrl
 * https://api.openai.com/v1. Handles both final-usage chunk shapes (OpenAI:
 * empty choices; OpenRouter: one empty-delta choice), `[DONE]`, comment lines
 * and in-stream `error` objects (HTTP 200 with finish_reason "error").
 * options.maxTokensParam: 'max_tokens' | 'max_completion_tokens'
 * (default: 'max_completion_tokens' for api.openai.com, else 'max_tokens').
 */
export function createOpenAiCompatibleProvider(config: ProviderConfig, env: ProviderEnv): LlmProvider {
  void config;
  void env;
  throw new Error('not implemented');
}
