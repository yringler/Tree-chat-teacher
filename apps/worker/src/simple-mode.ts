import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from '@tangent/core';
import { parseProviderConfigs } from '@tangent/providers';
import {
  BUILT_IN_PROVIDER_ID,
  DEFAULT_SYSTEM_PROMPT,
  LEGACY_BUILT_IN_PROVIDER_ID,
  type ModelInfo,
  type ProviderConfig,
} from '@tangent/shared';
import { appConfig } from './config.js';
import { groundingSettings } from './billing/grounding.js';
import type { AppEnv } from './env.js';
import type { PoolParams } from './pool/params.js';

export { DEFAULT_SIMPLE_MAX_INPUT_TOKENS } from './config.js';

/**
 * The built-in provider: the endpoint `openrouter` (BUILT_IN_PROVIDER_ID in
 * @tangent/shared) on the operator's OpenRouter key, metered per call and
 * paid from the user's prepaid credit or the open pool (PLAN §13). Its
 * provider id names only the endpoint; who pays is the funding (the request's
 * payment in Learn, the branch's funding in power), never the id. It is the
 * only provider config in a Learn account's registry, so the generic provider
 * checks (`assertGenerationAllowed`, `/api/providers`, tree and branch
 * validation) apply unchanged; power lists it after the user's own providers
 * as "Tangent credit", with any OpenRouter model allowed
 * (`builtInPowerConfig`), in a registry of its own. Learn also runs this
 * config on the user's own OpenRouter key, unmetered (services.ts `registryFor`).
 */

export { BUILT_IN_PROVIDER_ID };
/** Learn's provider id: the built-in endpoint (`openrouter`). */
export const SIMPLE_PROVIDER_ID = BUILT_IN_PROVIDER_ID;
export const DEFAULT_SIMPLE_SMART_MODEL = 'deepseek/deepseek-v4-pro';
export const DEFAULT_SIMPLE_FAST_MODEL = 'deepseek/deepseek-v4-flash';
/** What Learn's own key is: the user's OpenRouter key (cookie entry LEARN_KEY_PROVIDER). */
export const LEARN_KEY_LABEL = 'OpenRouter';
/** Output cap per call; with the input cap it bounds the cost of any one request. */
export const SIMPLE_RESERVED_OUTPUT_TOKENS = 4096;

function smartModel(env: AppEnv): string {
  return env.SIMPLE_SMART_MODEL?.trim() || DEFAULT_SIMPLE_SMART_MODEL;
}

function fastModel(env: AppEnv): string {
  return env.SIMPLE_FAST_MODEL?.trim() || DEFAULT_SIMPLE_FAST_MODEL;
}

/**
 * The built-in provider's config, as Learn uses it. `SIMPLE_PROVIDER` (one
 * ProviderConfig as JSON, id `openrouter`, or the legacy `tangent`, read as
 * `openrouter`) replaces it wholesale, e.g. a fake provider in tests or the
 * AI Gateway. The id is fixed so that a branch's provider id means the same
 * endpoint in both apps. There is deliberately no fallback to
 * OPENROUTER_API_KEY: customer spend stays on its own key, which can carry a
 * hard credit limit.
 */
export function simpleProviderConfig(env: AppEnv): ProviderConfig {
  const override = env.SIMPLE_PROVIDER?.trim();
  if (override) {
    const configs = parseProviderConfigs(override.startsWith('[') ? override : `[${override}]`);
    if (configs.length !== 1)
      throw new Error('Invalid SIMPLE_PROVIDER: expected exactly one provider config');
    const config = configs[0]!;
    if (config.id === LEGACY_BUILT_IN_PROVIDER_ID) return { ...config, id: SIMPLE_PROVIDER_ID };
    if (config.id !== SIMPLE_PROVIDER_ID)
      throw new Error(`Invalid SIMPLE_PROVIDER: id must be "${SIMPLE_PROVIDER_ID}"`);
    return config;
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
    // OpenRouter's web search server tool (grounding, see billing/grounding.ts).
    options: { webSearch: true },
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
 * The suggested OpenRouter models, smart first (SIMPLE_SMART_MODEL,
 * SIMPLE_FAST_MODEL): Learn's two tiers, and the models power lists first for
 * OpenRouter, on the user's own key or on credit.
 */
export function suggestedModels(env: AppEnv): ModelInfo[] {
  const smart = smartModel(env);
  const fast = fastModel(env);
  const models: ModelInfo[] = [{ id: smart, label: 'Smart (suggested)' }];
  if (fast !== smart) models.push({ id: fast, label: 'Simple (suggested)' });
  return models;
}

/** Learn's per-call input cap (`SIMPLE_MAX_INPUT_TOKENS`). */
export function simpleMaxInputTokens(env: AppEnv): number {
  return appConfig(env).simple.maxInputTokens;
}

/**
 * The built-in provider as power lists it: Learn's config (same key, same
 * SIMPLE_PROVIDER override), labelled "Tangent credit", with any model id
 * allowed (its models are suggestions) and one call's cost bounded like
 * Learn's: the context window is Learn's input cap plus its output reserve,
 * and output is capped at SIMPLE_RESERVED_OUTPUT_TOKENS. Per-model limits are
 * dropped so no listed model can widen those bounds.
 */
export function builtInPowerConfig(env: AppEnv): ProviderConfig {
  const base = simpleProviderConfig(env);
  return {
    ...base,
    label: 'Tangent credit',
    models: base.models.map(({ id, label }) => ({
      id,
      label: label.endsWith('(suggested)') ? label : `${label} (suggested)`,
    })),
    openModels: true,
    maxContextTokens: simpleMaxInputTokens(env) + SIMPLE_RESERVED_OUTPUT_TOKENS,
    maxOutputTokens: SIMPLE_RESERVED_OUTPUT_TOKENS,
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

/** Chat settings for simple accounts: capped input, fixed output reserve, cheap summaries. */
export function simpleChatSettings(env: AppEnv): ChatSettings {
  const config = simpleProviderConfig(env);
  return {
    ...DEFAULT_CHAT_SETTINGS,
    summaryProviderId: config.id,
    summaryModel: simpleFastModel(env, config),
    maxInputTokens: simpleMaxInputTokens(env),
    reservedOutputTokens: SIMPLE_RESERVED_OUTPUT_TOKENS,
    autoTitle: true,
    grounding: groundingSettings(env, 'simple'),
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

/**
 * The built-in provider as the open pool uses it: the simple config
 * (same key, same SIMPLE_PROVIDER override) with the pool model as its only
 * model, and one call's cost bounded by the pool's caps: the context window
 * is the pool's input cap plus its output cap. On OpenRouter, routing is
 * capped at the price table's price (`provider.max_price`, $/MTok), so an
 * over-priced route fails upstream (released) instead of costing the operator.
 * Other endpoints (OpenAI, Workers AI, local servers) get no `provider` field,
 * which strict APIs reject; there the table must be the endpoint's own price.
 */
export function poolProviderConfig(env: AppEnv, pool: PoolParams): ProviderConfig {
  const base = simpleProviderConfig(env);
  const listed = base.models.find((m) => m.id === pool.model);
  const config: ProviderConfig = {
    ...base,
    models: [{ id: pool.model, label: listed?.label ?? 'Simple' }],
    defaultModel: pool.model,
    openModels: false,
    maxContextTokens: pool.maxInputTokens + pool.maxOutputTokens,
    maxOutputTokens: pool.maxOutputTokens,
  };
  if (base.kind !== 'openai-compatible' || !isOpenRouter(base.baseUrl) || !pool.price)
    return config;
  const extraBody = asRecord(base.options?.['extraBody']);
  // Merged into the operator's own routing (e.g. `data_collection: 'deny'`),
  // keeping a stricter `max_price` they set.
  const routing = asRecord(extraBody['provider']);
  const priorMax = asRecord(routing['max_price']);
  return {
    ...config,
    options: {
      ...base.options,
      extraBody: {
        ...extraBody,
        provider: {
          ...routing,
          max_price: {
            ...priorMax,
            prompt: lowerPrice(priorMax['prompt'], pool.price.inMicrosPerMTok / 1_000_000),
            completion: lowerPrice(priorMax['completion'], pool.price.outMicrosPerMTok / 1_000_000),
          },
        },
      },
    },
  };
}

/**
 * Whether an openai-compatible base URL reaches OpenRouter: openrouter.ai
 * itself, or the AI Gateway's OpenRouter route (`.../openrouter`). Unset means
 * the provider's own default, api.openai.com.
 */
export function isOpenRouter(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    if (url.hostname === 'openrouter.ai') return true;
    return (
      url.hostname === 'gateway.ai.cloudflare.com' &&
      url.pathname.replace(/\/+$/, '').endsWith('/openrouter')
    );
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The operator's price cap when it is a stricter number, else the pool's. */
function lowerPrice(prior: unknown, pool: number): number {
  return typeof prior === 'number' && Number.isFinite(prior) && prior >= 0
    ? Math.min(prior, pool)
    : pool;
}

/**
 * Chat settings of a pool generation: the pool's input and output caps, and
 * summaries and titles on the pool model (so on the pool too).
 */
export function poolChatSettings(pool: PoolParams): ChatSettings {
  return {
    ...DEFAULT_CHAT_SETTINGS,
    summaryProviderId: SIMPLE_PROVIDER_ID,
    summaryModel: pool.model,
    maxInputTokens: pool.maxInputTokens,
    reservedOutputTokens: pool.maxOutputTokens,
    autoTitle: true,
    // No web search on the pool: its holds are priced from tokens alone (docs/DEFERRED.md).
    grounding: { ...DEFAULT_CHAT_SETTINGS.grounding, policy: 'off' },
  };
}

/**
 * What Learn offers, as the public pages (landing, pricing) describe it, read
 * from the built-in provider's config: its models (Learn's tiers, the default
 * first), whether it is OpenRouter (so credit takes "any OpenRouter model"),
 * whether its replies can search the web, and whether a search costs about
 * 1¢ (OpenRouter's Exa price covers up to 10 results; other engines and more
 * results cost differently). Null when SIMPLE_PROVIDER is invalid, so a page
 * falls back to wording that claims none of these.
 */
export interface LearnOffer {
  tiers: { id: string; label: string }[];
  openRouter: boolean;
  search: boolean;
  searchAboutOneCent: boolean;
}

export function learnOffer(env: AppEnv): LearnOffer | null {
  let config: ProviderConfig;
  try {
    config = simpleProviderConfig(env);
  } catch {
    return null;
  }
  const isDefault = (id: string) => (id === config.defaultModel ? 0 : 1);
  const tiers = [...config.models]
    .sort((a, b) => isDefault(a.id) - isDefault(b.id))
    .map(({ id, label }) => ({ id, label }));
  const openRouter = config.kind === 'openai-compatible' && isOpenRouter(config.baseUrl);
  const grounding = groundingSettings(env, 'simple');
  return {
    tiers,
    openRouter,
    search: config.options?.['webSearch'] === true,
    searchAboutOneCent: openRouter && grounding.engine === 'exa' && grounding.maxResults <= 10,
  };
}
