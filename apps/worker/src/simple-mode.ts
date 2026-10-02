import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from '@tangent/core';
import { parseProviderConfigs } from '@tangent/providers';
import { DEFAULT_SYSTEM_PROMPT, type ProviderConfig } from '@tangent/shared';
import type { AppEnv } from './env.js';

/**
 * Simple mode (the /learn/ app): one server-side provider, `tangent`, paid
 * for by the operator's OpenRouter key and metered per account (PLAN §2.2).
 * It is the only provider in a simple account's registry, so the generic
 * provider checks (`assertGenerationAllowed`, `/api/providers`, tree and
 * branch validation) apply unchanged.
 */

export const SIMPLE_PROVIDER_ID = 'tangent';
export const DEFAULT_SIMPLE_SMART_MODEL = 'deepseek/deepseek-v4-pro';
export const DEFAULT_SIMPLE_FAST_MODEL = 'deepseek/deepseek-v4-flash';
export const DEFAULT_SIMPLE_MAX_INPUT_TOKENS = 60_000;
/** Output cap per call; with the input cap it bounds the cost of any one request. */
export const SIMPLE_RESERVED_OUTPUT_TOKENS = 4096;

function smartModel(env: AppEnv): string {
  return env.SIMPLE_SMART_MODEL?.trim() || DEFAULT_SIMPLE_SMART_MODEL;
}

function fastModel(env: AppEnv): string {
  return env.SIMPLE_FAST_MODEL?.trim() || DEFAULT_SIMPLE_FAST_MODEL;
}

/**
 * The `tangent` provider. `SIMPLE_PROVIDER` (one ProviderConfig as JSON)
 * replaces it wholesale, e.g. a fake provider in tests or the AI Gateway.
 * There is deliberately no fallback to OPENROUTER_API_KEY: customer spend
 * stays on its own key, which can carry a hard credit limit.
 */
export function simpleProviderConfig(env: AppEnv): ProviderConfig {
  const override = env.SIMPLE_PROVIDER?.trim();
  if (override) {
    const configs = parseProviderConfigs(override.startsWith('[') ? override : `[${override}]`);
    if (configs.length !== 1)
      throw new Error('Invalid SIMPLE_PROVIDER: expected exactly one provider config');
    return configs[0]!;
  }
  const smart = smartModel(env);
  const fast = fastModel(env);
  return {
    id: SIMPLE_PROVIDER_ID,
    kind: 'openai-compatible',
    label: 'Tangent',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeySecret: 'OPENROUTER_SIMPLE_API_KEY',
    defaultModel: smart,
    models:
      smart === fast
        ? [{ id: smart, label: 'Smart' }]
        : [
            { id: smart, label: 'Smart' },
            { id: fast, label: 'Simple' },
          ],
  };
}

/**
 * The cheaper model of the simple provider (summaries and titles):
 * SIMPLE_FAST_MODEL when the config lists it, else the config's second
 * model (the "Simple" tier), else its default.
 */
export function simpleFastModel(
  env: AppEnv,
  config: ProviderConfig = simpleProviderConfig(env),
): string {
  const wanted = fastModel(env);
  const models = config.models;
  return models.find((m) => m.id === wanted)?.id ?? models[1]?.id ?? config.defaultModel;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Chat settings for simple accounts: capped input, fixed output reserve, cheap summaries. */
export function simpleChatSettings(env: AppEnv): ChatSettings {
  const config = simpleProviderConfig(env);
  return {
    ...DEFAULT_CHAT_SETTINGS,
    summaryProviderId: config.id,
    summaryModel: simpleFastModel(env, config),
    maxInputTokens: positiveInt(env.SIMPLE_MAX_INPUT_TOKENS, DEFAULT_SIMPLE_MAX_INPUT_TOKENS),
    reservedOutputTokens: SIMPLE_RESERVED_OUTPUT_TOKENS,
    autoTitle: true,
  };
}

/**
 * Default system prompt for trees created by simple accounts that have no
 * saved prompt: SIMPLE_SYSTEM_PROMPT when set, else the built-in prompt
 * shared with power mode (DEFAULT_SYSTEM_PROMPT in @tangent/shared).
 */
export function simpleSystemPrompt(env: AppEnv): string {
  return env.SIMPLE_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT;
}
