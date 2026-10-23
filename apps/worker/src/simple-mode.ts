import { appChatSettings, DEFAULT_CHAT_SETTINGS, type ChatSettings } from '@tangent/core';
import { parseProviderConfigs, providerTraits } from '@tangent/providers';
import {
  ANTHROPIC_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
  DEFAULT_SYSTEM_PROMPT,
  TIER_LABELS,
  TIERS,
  BUILT_IN_MAX_OUTPUT_TOKENS,
  tierModel,
  tierOf,
  type LearnKeyProvider,
  type ModelInfo,
  type ModelTier,
  type ProviderConfig,
  type ReasoningEffort,
} from '@tangent/shared';
import {
  appConfig,
  backgroundEffort,
  DEFAULT_TIER_REQUESTS,
  withTierDefaults,
  type TierRequestConfig,
} from './config.js';
import { groundingPolicy } from './billing/grounding.js';
import type { AppEnv } from './env.js';
import { openRouterBackend, withMaxPrice } from './hosted/openrouter.js';
import { hostedChain } from './hosted/registry.js';
import type { PoolParams } from './pool/params.js';

export {
  DEFAULT_BACKGROUND_MODEL,
  DEFAULT_LEARN_NORMAL_MODEL,
  DEFAULT_POWER_MAX_MODEL,
} from './config.js';

/*
 * The built-in provider: the endpoint `openrouter` (OPENROUTER_PROVIDER_ID in
 * @tangent/shared) on the operator's keys, metered per call and paid from
 * the user's prepaid credit or the open pool; those calls run on hosted
 * backends (hosted/: OpenRouter, and Anthropic's own API for the Claude
 * models when configured). Its
 * provider id names only the endpoint; who pays is the funding (the request's
 * payment in Learn, the branch's funding in power), never the id. It is the
 * only provider config in a Learn account's registry, so the generic provider
 * checks (`assertGenerationAllowed`, `/api/providers`, tree and branch
 * validation) apply unchanged; power lists it after the user's own providers
 * as "Tangent credit", with any OpenRouter model allowed
 * (`builtInPowerConfig`), in a registry of its own. Learn also runs this
 * config on the user's own OpenRouter key, unmetered (registries.ts `registryFor`).
 * Learn replies on Normal, or on Max where the learner chose it in their
 * reply settings (`LearnProfile.reply`). On the user's own Anthropic key, Learn runs power's Anthropic endpoint on
 * a fixed pair of models instead (`LEARN_ANTHROPIC_REPLY_MODEL`,
 * provider-configs.ts `learnKeyConfig`).
 */

/**
 * What Learn replies with on the learner's own Anthropic key, whatever a
 * branch stores: the one model that key's config lists, so every other model
 * runs as this one (`RouteResolver.runnable`). Constants, not vars: Learn has
 * nothing to configure, and power is where a learner picks models.
 */
export const LEARN_ANTHROPIC_REPLY_MODEL = 'claude-sonnet-5-5';
/** Titles and summaries on the learner's own Anthropic key: cheaper, and quick enough. */
export const LEARN_ANTHROPIC_BACKGROUND_MODEL = 'claude-haiku-5-5';
/**
 * Their effort: as little thinking as the hosted background calls
 * (`DEFAULT_BACKGROUND_EFFORT`), where Haiku 5.5 would otherwise think at its
 * own default, medium.
 */
export const LEARN_ANTHROPIC_BACKGROUND_EFFORT: ReasoningEffort = 'low';
/** Output cap of a reply on a model that doesn't reason. */
export const SIMPLE_RESERVED_OUTPUT_TOKENS = 4096;
/**
 * The most output one call on the built-in provider asks for: a reasoning
 * model's reply (its thinking counts as output), or power's own setting on
 * Tangent credit. With the input cap it bounds the cost of any one request.
 */
export const SIMPLE_MAX_OUTPUT_TOKENS = BUILT_IN_MAX_OUTPUT_TOKENS;

/**
 * The built-in provider's config, as Learn uses it, whoever pays (credit or
 * the learner's own key): Normal (`LEARN_NORMAL_MODEL`), its default, with
 * its request settings (`LEARN_NORMAL_EFFORT`, `_REPLY_TOKENS`,
 * `_PROVIDER_ORDER`; empty ones are the default model's evaluated settings,
 * `withTierDefaults`), and Max (`POWER_MAX_MODEL`) at the model's own
 * defaults, which a reply runs on only where the learner chose Max
 * (`RouteResolver.runnable`). With a `BUILT_IN_PROVIDER` override, every
 * model it lists.
 */
export function simpleProviderConfig(env: AppEnv): ProviderConfig {
  return builtInConfig(env);
}

/**
 * The built-in provider with every model it offers: Normal (the default)
 * then power's Max, each tagged with its `tier`. `BUILT_IN_PROVIDER` (one
 * ProviderConfig as JSON, id `openrouter`) replaces it wholesale, e.g. a fake
 * provider in tests or the AI Gateway; its models name their own `tier` and
 * carry their own request settings, and its default can't be a Max model,
 * since Learn runs on it. The id is fixed so that a branch's provider id
 * means the same endpoint in both apps. There is deliberately no fallback to
 * OPENROUTER_API_KEY: customer spend stays on its own key, which can carry a
 * hard credit limit.
 */
function builtInConfig(env: AppEnv): ProviderConfig {
  const { builtIn, learn } = appConfig(env);
  const override = builtIn.provider;
  if (override) {
    const configs = parseProviderConfigs(override.startsWith('[') ? override : `[${override}]`);
    if (configs.length !== 1)
      throw new Error('Invalid BUILT_IN_PROVIDER: expected exactly one provider config');
    const config = configs[0]!;
    if (config.id !== OPENROUTER_PROVIDER_ID)
      throw new Error(`Invalid BUILT_IN_PROVIDER: id must be "${OPENROUTER_PROVIDER_ID}"`);
    if (tierOf(config.models, config.defaultModel) === 'max')
      throw new Error('Invalid BUILT_IN_PROVIDER: the default model must not be a Max model');
    return config;
  }
  return {
    id: OPENROUTER_PROVIDER_ID,
    ...openRouterBackend.config(),
    label: 'Tangent',
    defaultModel: learn.normalModel,
    // Power asks Max as the user sets it, so only Normal carries request settings.
    models: tierModels(env, (tier) => TIER_LABELS[tier]).map((m) =>
      m.tier === 'normal'
        ? withRequestConfig(m, withTierDefaults(learn.normal, DEFAULT_TIER_REQUESTS.normal, m.id))
        : m,
    ),
  };
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
  const { learn, power } = appConfig(env);
  const ids: Record<ModelTier, string> = { normal: learn.normalModel, max: power.maxModel };
  const tiers = ids.normal === ids.max ? TIERS.slice(0, 1) : TIERS;
  return tiers.map((tier) => ({ id: ids[tier], label: label(tier), tier }));
}

/**
 * The models power suggests first for OpenRouter on the user's own key,
 * Normal then Max (LEARN_NORMAL_MODEL, POWER_MAX_MODEL), as on Tangent credit.
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
 * BUILT_IN_PROVIDER override) with power's Max too, labelled "Tangent
 * credit", with any model id allowed (its models are suggestions) and one
 * call's cost bounded like Learn's: the context window is Learn's input cap
 * plus its output reserve, and output is capped at SIMPLE_MAX_OUTPUT_TOKENS.
 * Per-model settings are dropped, so no listed model can widen those bounds,
 * and power asks each model as the user sets it.
 */
export function builtInPowerConfig(env: AppEnv): ProviderConfig {
  const base = builtInConfig(env);
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
 * The background model of the simple provider (summaries and titles):
 * BACKGROUND_MODEL, which the default config needn't list (it is no tier,
 * and OpenRouter takes any model id), as `onBuiltIn` resolves it.
 */
export function simpleFastModel(
  env: AppEnv,
  config: ProviderConfig = simpleProviderConfig(env),
): string {
  return onBuiltIn(env, appConfig(env).background.model, config);
}

/**
 * `wanted` on the built-in provider. A BUILT_IN_PROVIDER override is a
 * closed list, so there it is `wanted` when Learn's models include it, else
 * the override's default.
 */
function onBuiltIn(env: AppEnv, wanted: string, config: ProviderConfig): string {
  if (!appConfig(env).builtIn.provider) return wanted;
  return config.models.some((m) => m.id === wanted) ? wanted : config.defaultModel;
}

/**
 * Chat settings for simple accounts: capped input, fixed output reserve,
 * cheap summaries. On the learner's own Anthropic key (`ownKey`) summaries
 * and titles run on LEARN_ANTHROPIC_BACKGROUND_MODEL at
 * LEARN_ANTHROPIC_BACKGROUND_EFFORT, since the background vars describe the
 * built-in provider's model.
 */
export function simpleChatSettings(env: AppEnv, ownKey: LearnKeyProvider): ChatSettings {
  const summary =
    ownKey === ANTHROPIC_PROVIDER_ID
      ? {
          summaryProviderId: ANTHROPIC_PROVIDER_ID,
          summaryModel: LEARN_ANTHROPIC_BACKGROUND_MODEL,
          summaryEffort: LEARN_ANTHROPIC_BACKGROUND_EFFORT,
        }
      : simpleSummaries(env);
  return appChatSettings('learn', {
    ...summary,
    maxInputTokens: simpleMaxInputTokens(env),
    reservedOutputTokens: SIMPLE_RESERVED_OUTPUT_TOKENS,
    reasoningOutputTokens: SIMPLE_MAX_OUTPUT_TOKENS,
    groundingPolicy: groundingPolicy(env),
  });
}

/** Where Learn's summaries and titles run on the built-in provider: its background model. */
function simpleSummaries(env: AppEnv) {
  const config = simpleProviderConfig(env);
  const summaryModel = simpleFastModel(env, config);
  return {
    summaryProviderId: config.id,
    summaryModel,
    summaryEffort: backgroundEffort(env, summaryModel),
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
 * The built-in provider as the open pool uses it: the simple config (same
 * key, same BUILT_IN_PROVIDER override) with Normal's listing as its only
 * model, as Normal asks it (its effort and pinned providers), and one call's
 * cost bounded by the pool's caps: the context window is the pool's input
 * cap plus its output cap, which replaces Normal's reply cap. On a routing endpoint (OpenRouter,
 * `ProviderTraits.routing`), routing is also capped at the price table's
 * price (`provider.max_price`, $/MTok), so an over-priced route fails
 * upstream (released) instead of costing the operator; pinning merges with
 * it (openai-compatible.ts). Other endpoints (OpenAI, Workers AI, local
 * servers) get no `provider` field, which strict APIs reject; there the
 * table must be the endpoint's own price.
 */
export function poolProviderConfig(env: AppEnv, pool: PoolParams): ProviderConfig {
  const base = simpleProviderConfig(env);
  const listed = base.models.find((m) => m.id === pool.model) ?? {
    id: pool.model,
    label: TIER_LABELS.normal,
  };
  const config: ProviderConfig = {
    ...base,
    models: [{ ...listed, maxOutputTokens: pool.maxOutputTokens }],
    defaultModel: pool.model,
    openModels: false,
    maxContextTokens: pool.maxInputTokens + pool.maxOutputTokens,
    maxOutputTokens: pool.maxOutputTokens,
  };
  if (!providerTraits(base).routing || !pool.price) return config;
  return withMaxPrice(config, pool.price);
}

/**
 * Chat settings of a pool generation: the pool's input and output caps, and
 * summaries and titles on the pool model (so on the pool too, whose holds are
 * priced for that one model) at the background effort, as on credit.
 */
export function poolChatSettings(pool: PoolParams): ChatSettings {
  return {
    ...DEFAULT_CHAT_SETTINGS,
    summaryProviderId: OPENROUTER_PROVIDER_ID,
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
 * from the built-in provider's config: the Max power suggests on credit (null
 * when it lists none), whether its replies can search the web, and whether a
 * search costs about 1¢ on every backend Learn's model may run on
 * (Anthropic's search is 1¢; OpenRouter's Exa price covers up to 10 results,
 * and other engines, other catalogs and more results cost differently). Null
 * when BUILT_IN_PROVIDER is invalid, so a page falls back to wording that
 * claims none of these.
 */
export interface LearnOffer {
  /** The label of power's Max on Tangent credit; null when the provider lists no Max. */
  powerMax: string | null;
  search: boolean;
  searchAboutOneCent: boolean;
}

export function learnOffer(env: AppEnv): LearnOffer | null {
  let config: ProviderConfig;
  try {
    config = builtInConfig(env);
  } catch {
    return null;
  }
  const openRouterPrices = providerTraits(config).catalog === 'openrouter';
  const { engine, maxResults } = appConfig(env).grounding;
  const exaCent = openRouterPrices && engine === 'exa' && maxResults <= 10;
  // OpenRouter's leg runs on the built-in config; GROUNDING_ENGINE and _MAX_RESULTS are its alone.
  const aboutOneCent = hostedChain(env, config.defaultModel).every(({ backend }) =>
    backend === openRouterBackend ? exaCent : backend.config().kind === 'anthropic',
  );
  return {
    powerMax: tierModel(config.models, 'max')?.label ?? null,
    search: config.options?.['webSearch'] === true,
    searchAboutOneCent: aboutOneCent,
  };
}
