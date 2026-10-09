import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from '@tangent/core';
import { parseProviderConfigs } from '@tangent/providers';
import {
  BUILT_IN_PROVIDER_ID,
  DEFAULT_SYSTEM_PROMPT,
  TIER_LABELS,
  TIERS,
  BUILT_IN_MAX_OUTPUT_TOKENS,
  type ModelInfo,
  type ModelTier,
  type ProviderConfig,
} from '@tangent/shared';
import {
  appConfig,
  backgroundEffort,
  BUILT_IN_API_KEY_SECRET,
  DEFAULT_TIER_REQUESTS,
  namedSecrets,
  withTierDefaults,
  type TierRequestConfig,
} from './config.js';
import { groundingSettings } from './billing/grounding.js';
import type { AppEnv } from './env.js';
import type { PoolParams } from './pool/params.js';

export {
  DEFAULT_BACKGROUND_MODEL,
  DEFAULT_LEARN_MAX_MODEL,
  DEFAULT_LEARN_NORMAL_MODEL,
} from './config.js';

/**
 * The built-in provider: the endpoint `openrouter` (BUILT_IN_PROVIDER_ID in
 * @tangent/shared) on the operator's OpenRouter key, metered per call and
 * paid from the user's prepaid credit or the open pool. Its
 * provider id names only the endpoint; who pays is the funding (the request's
 * payment in Learn, the branch's funding in power), never the id. It is the
 * only provider config in a Learn account's registry, so the generic provider
 * checks (`assertGenerationAllowed`, `/api/providers`, tree and branch
 * validation) apply unchanged; power lists it after the user's own providers
 * as "Tangent credit", with any OpenRouter model allowed
 * (`builtInPowerConfig`), in a registry of its own. Learn also runs this
 * config on the user's own OpenRouter key, unmetered (registries.ts `registryFor`).
 */

export { BUILT_IN_PROVIDER_ID };
/** Learn's provider id: the built-in endpoint (`openrouter`). */
export const SIMPLE_PROVIDER_ID = BUILT_IN_PROVIDER_ID;
/** What the pool model is called where Learn's config doesn't list it (it is no tier). */
export const POOL_MODEL_LABEL = 'Lite';
/** What Learn's own key is: the user's OpenRouter key (cookie entry LEARN_KEY_PROVIDER). */
export const LEARN_KEY_LABEL = 'OpenRouter';
/** Output cap of a reply on a model that doesn't reason. */
export const SIMPLE_RESERVED_OUTPUT_TOKENS = 4096;
/**
 * The most output one call on the built-in provider asks for: a reasoning
 * model's reply (its thinking counts as output), or power's own setting on
 * Tangent credit. With the input cap it bounds the cost of any one request.
 */
export const SIMPLE_MAX_OUTPUT_TOKENS = BUILT_IN_MAX_OUTPUT_TOKENS;

/**
 * The built-in provider's config, as Learn uses it: its tiers, Normal (the
 * default) then Max, each tagged with its `tier`. `BUILT_IN_PROVIDER` (one
 * ProviderConfig as JSON, id `openrouter`) replaces it wholesale, e.g. a fake
 * provider in tests or the AI Gateway; its models name their own `tier`, and
 * one that names none offers no tiers. The id is fixed so that a branch's
 * provider id means the same endpoint in both apps. There is deliberately no fallback
 * to OPENROUTER_API_KEY: customer spend stays on its own key, which can carry
 * a hard credit limit.
 *
 * The default config's tier models carry their tier's request settings
 * (`LEARN_NORMAL_EFFORT`, `_REPLY_TOKENS`, `_PROVIDER_ORDER`, and Max's;
 * empty ones are the default model's evaluated settings, `withTierDefaults`), so
 * a tier is a model plus how it is asked, whoever pays (credit or the
 * learner's own key); an override's models carry their own.
 */
export function simpleProviderConfig(env: AppEnv): ProviderConfig {
  const { builtIn, learn } = appConfig(env);
  const override = builtIn.provider;
  if (override) {
    const configs = parseProviderConfigs(override.startsWith('[') ? override : `[${override}]`);
    if (configs.length !== 1)
      throw new Error('Invalid BUILT_IN_PROVIDER: expected exactly one provider config');
    const config = configs[0]!;
    if (config.id !== SIMPLE_PROVIDER_ID)
      throw new Error(`Invalid BUILT_IN_PROVIDER: id must be "${SIMPLE_PROVIDER_ID}"`);
    return config;
  }
  return {
    id: SIMPLE_PROVIDER_ID,
    kind: 'openai-compatible',
    label: 'Tangent',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeySecret: BUILT_IN_API_KEY_SECRET,
    defaultModel: learn.normalModel,
    // OpenRouter's web search server tool (grounding, see billing/grounding.ts).
    options: { webSearch: true },
    models: tierModels(env, (tier) => TIER_LABELS[tier]).map((m) =>
      m.tier
        ? withRequestConfig(m, withTierDefaults(learn[m.tier], DEFAULT_TIER_REQUESTS[m.tier], m.id))
        : m,
    ),
  };
}

/**
 * The OpenRouter key the built-in provider spends: the secret named by
 * `BUILT_IN_PROVIDER.apiKeySecret` when set, else `BUILT_IN_API_KEY`.
 */
export function simpleApiKey(env: AppEnv): string | null {
  let secretName = BUILT_IN_API_KEY_SECRET;
  const override = appConfig(env).builtIn.provider;
  if (override) {
    try {
      const parsed: unknown = JSON.parse(override);
      const config: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
      if (typeof config === 'object' && config !== null) {
        const name = (config as Record<string, unknown>)['apiKeySecret'];
        if (typeof name === 'string' && name) secretName = name;
      }
    } catch {
      // Invalid BUILT_IN_PROVIDER fails loudly where the registry is built; keep the default here.
    }
  }
  const value = namedSecrets(env, new Set([secretName]))[secretName];
  return value?.trim() || null;
}

/**
 * `model` with a hosted tier's request settings (only those set): its effort,
 * its reply cap as the model's `maxOutputTokens` (a reply's default cap stays
 * below it, ChatService `budgetFor`), and its pinned providers.
 */
export function withRequestConfig(
  model: ModelInfo,
  request: Omit<TierRequestConfig, 'maxOutputTokens'> & { maxOutputTokens?: number | null },
): ModelInfo {
  return {
    ...model,
    ...(request.effort !== null ? { effort: request.effort } : {}),
    ...(request.maxOutputTokens != null ? { maxOutputTokens: request.maxOutputTokens } : {}),
    ...(request.providerOrder.length > 0 ? { providerOrder: [...request.providerOrder] } : {}),
  };
}

/** Normal then Max, labelled by `label`; Normal alone when both are the same model. */
function tierModels(env: AppEnv, label: (tier: ModelTier) => string): ModelInfo[] {
  const { normalModel, maxModel } = appConfig(env).learn;
  const ids: Record<ModelTier, string> = { normal: normalModel, max: maxModel };
  const tiers = ids.normal === ids.max ? TIERS.slice(0, 1) : TIERS;
  return tiers.map((tier) => ({ id: ids[tier], label: label(tier), tier }));
}

/**
 * The suggested OpenRouter models, Normal first (LEARN_NORMAL_MODEL,
 * LEARN_MAX_MODEL): Learn's two tiers, and the models power lists first for
 * OpenRouter, on the user's own key or on credit.
 */
export function suggestedModels(env: AppEnv): ModelInfo[] {
  return tierModels(env, (tier) => `${TIER_LABELS[tier]} (suggested)`);
}

/** Learn's per-call input cap (`BUILT_IN_MAX_INPUT_TOKENS`). */
export function simpleMaxInputTokens(env: AppEnv): number {
  return appConfig(env).builtIn.maxInputTokens;
}

/**
 * The built-in provider as power lists it: Learn's config (same key, same
 * BUILT_IN_PROVIDER override), labelled "Tangent credit", with any model id
 * allowed (its models are suggestions) and one call's cost bounded like
 * Learn's: the context window is Learn's input cap plus its output reserve,
 * and output is capped at SIMPLE_MAX_OUTPUT_TOKENS. Per-model limits are
 * dropped so no listed model can widen those bounds.
 */
export function builtInPowerConfig(env: AppEnv): ProviderConfig {
  const base = simpleProviderConfig(env);
  return {
    ...base,
    label: 'Tangent credit',
    models: base.models.map(({ id, label, tier }) => ({
      id,
      label: label.endsWith('(suggested)') ? label : `${label} (suggested)`,
      ...(tier ? { tier } : {}),
    })),
    openModels: true,
    maxContextTokens: simpleMaxInputTokens(env) + SIMPLE_MAX_OUTPUT_TOKENS,
    maxOutputTokens: SIMPLE_MAX_OUTPUT_TOKENS,
  };
}

/**
 * The background model of the simple provider (summaries, titles, and the
 * pool's default model): BACKGROUND_MODEL, which the default config needn't
 * list (it is no tier, and OpenRouter takes any model id). A BUILT_IN_PROVIDER
 * override is a closed list, so there it is BACKGROUND_MODEL when the
 * override lists it, else the override's default (never another tier, which
 * could be Max).
 */
export function simpleFastModel(
  env: AppEnv,
  config: ProviderConfig = simpleProviderConfig(env),
): string {
  const { background, builtIn } = appConfig(env);
  const wanted = background.model;
  if (!builtIn.provider) return wanted;
  return config.models.some((m) => m.id === wanted) ? wanted : config.defaultModel;
}

/** Chat settings for simple accounts: capped input, fixed output reserve, cheap summaries. */
export function simpleChatSettings(env: AppEnv): ChatSettings {
  const config = simpleProviderConfig(env);
  const summaryModel = simpleFastModel(env, config);
  return {
    ...DEFAULT_CHAT_SETTINGS,
    summaryProviderId: config.id,
    summaryModel,
    summaryEffort: backgroundEffort(env, summaryModel),
    maxInputTokens: simpleMaxInputTokens(env),
    reservedOutputTokens: SIMPLE_RESERVED_OUTPUT_TOKENS,
    reasoningOutputTokens: SIMPLE_MAX_OUTPUT_TOKENS,
    autoTitle: true,
    grounding: groundingSettings(env, 'simple'),
  };
}

/**
 * Default system prompt for trees created by simple accounts that have no
 * saved prompt: LEARN_SYSTEM_PROMPT when set, else the built-in prompt
 * shared with power mode (DEFAULT_SYSTEM_PROMPT in @tangent/shared).
 */
export function simpleSystemPrompt(env: AppEnv): string {
  return appConfig(env).learn.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
}

/**
 * The built-in provider as the open pool uses it: the simple config
 * (same key, same BUILT_IN_PROVIDER override) with the pool model as its only
 * model, and one call's cost bounded by the pool's caps: the context window
 * is the pool's input cap plus its output cap. On OpenRouter, routing is
 * capped at the price table's price (`provider.max_price`, $/MTok), so an
 * over-priced route fails upstream (released) instead of costing the operator.
 * Other endpoints (OpenAI, Workers AI, local servers) get no `provider` field,
 * which strict APIs reject; there the table must be the endpoint's own price.
 * The pool model carries the pool's own effort and pinned providers
 * (`POOL_EFFORT`, `POOL_PROVIDER_ORDER`), never a tier's, even when a tier
 * runs the same model; pinning merges with `max_price` (openai-compatible.ts).
 */
export function poolProviderConfig(env: AppEnv, pool: PoolParams): ProviderConfig {
  const base = simpleProviderConfig(env);
  const listed = base.models.find((m) => m.id === pool.model);
  const config: ProviderConfig = {
    ...base,
    models: [
      withRequestConfig(
        { id: pool.model, label: listed?.label ?? POOL_MODEL_LABEL },
        { effort: pool.effort, providerOrder: pool.providerOrder },
      ),
    ],
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
    summaryEffort: pool.summaryEffort,
    maxInputTokens: pool.maxInputTokens,
    reservedOutputTokens: pool.maxOutputTokens,
    reasoningOutputTokens: pool.maxOutputTokens,
    autoTitle: true,
    // No web search on the pool: its holds are priced from tokens alone (docs/DEFERRED.md).
    grounding: { ...DEFAULT_CHAT_SETTINGS.grounding, policy: 'off' },
  };
}

/**
 * What Learn offers, as the public pages (landing, pricing) describe it, read
 * from the built-in provider's config: its models (Learn's tiers: Normal,
 * Max, then any model that is no tier), whether it is OpenRouter (so credit
 * takes "any OpenRouter model"), whether its replies can search the web, and
 * whether a search costs about 1¢ (OpenRouter's Exa price covers up to 10
 * results; other engines and more results cost differently). Null when
 * BUILT_IN_PROVIDER is invalid, so a page falls back to wording that claims
 * none of these.
 */
export interface LearnOffer {
  tiers: { id: string; label: string; tier?: ModelTier }[];
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
  const rank = (tier: ModelTier | undefined) => (tier ? TIERS.indexOf(tier) : TIERS.length);
  const tiers = [...config.models]
    .sort((a, b) => rank(a.tier) - rank(b.tier))
    .map(({ id, label, tier }) => ({ id, label, ...(tier ? { tier } : {}) }));
  const openRouter = config.kind === 'openai-compatible' && isOpenRouter(config.baseUrl);
  const grounding = groundingSettings(env, 'simple');
  return {
    tiers,
    openRouter,
    search: config.options?.['webSearch'] === true,
    searchAboutOneCent: openRouter && grounding.engine === 'exa' && grounding.maxResults <= 10,
  };
}
