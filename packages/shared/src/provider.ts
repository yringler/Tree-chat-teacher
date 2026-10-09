import type { ChatMessage } from './context-plan.js';
import type { BranchFunding, TokenUsage } from './domain.js';
import type { Citation } from './grounding.js';

/**
 * Provider abstraction. Implementations live in @tangent/providers and depend
 * only on standard Web APIs (fetch, ReadableStream, TextDecoder, AbortSignal).
 */

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'fake';

export interface ProviderCapabilities {
  /** Total context window (input + output) in tokens. */
  maxContextTokens: number;
  /** Default/max output tokens we request. */
  maxOutputTokens: number;
  /** If false, the system prompt is folded into the first user message by the renderer. */
  supportsSystemPrompt: boolean;
  /** True if `countTokens` is implemented and exact for this model. */
  supportsTokenCount: boolean;
  /** True when the provider can run a web search for a reply (`GenerateRequest.webSearch`). */
  supportsWebSearch: boolean;
  /**
   * True when it can also make the model search (`WebSearchRequest.mode`
   * `required`). False where a search can only be offered (Anthropic, whose
   * models reject a forced tool choice): a reply that must check its sources
   * is then offered one and asked to use it. Absent = false.
   */
  requiredWebSearch?: boolean;
  /**
   * True for a reasoning model (`ModelInfo.reasoning`, else `isReasoningModel`):
   * its thinking counts as output, so replies get a larger cap (output-tokens.ts).
   * Absent = false.
   */
  reasoning?: boolean;
  /**
   * False when the model's text can't name a conversation (the scripted test
   * provider, which echoes the prompt): branches keep their default titles.
   * Absent = true.
   */
  titles?: boolean;
}

/**
 * A model's place in the two-tier offer: `normal` (the everyday default) or
 * `max` (a stronger, pricier model). Labels live in `TIER_LABELS` (tiers.ts).
 */
export type ModelTier = 'normal' | 'max';

export interface ModelInfo {
  id: string;
  label: string;
  /** Overrides the provider-level capability defaults for this model. */
  maxContextTokens?: number;
  maxOutputTokens?: number;
  /**
   * The tier this model is (Learn's Normal/Max, power's suggested pair).
   * Clients key on this, never on `label`. Absent = not a tier.
   */
  tier?: ModelTier;
  /**
   * Max only: about how many Normal replies' worth of usage one Max reply is
   * (a whole number >= 1, from list prices; set by the server, never read
   * from config). Absent = unknown.
   */
  usageFactor?: number;
  /** Whether the model reasons (thinks before answering); absent = `isReasoningModel(id)`. */
  reasoning?: boolean;
  /**
   * The reasoning effort to ask this model for (`GenerateRequest.reasoning`
   * overrides it per call); absent = send none, the model's own default.
   * Sent on OpenRouter only. Server-side config: not listed to clients.
   */
  effort?: ReasoningEffort;
  /**
   * OpenRouter only: the upstream providers to try first, in order (slugs such
   * as `streamlake/fp8`), sent as `provider: {order, allow_fallbacks: true}`. Pinning
   * keeps a model's prompt cache, which each upstream keeps for itself, and
   * its price. Absent or empty = OpenRouter's own routing. Server-side config:
   * not listed to clients.
   */
  providerOrder?: string[];
}

/**
 * How hard a reasoning model thinks: `none` asks it not to (OpenRouter
 * `reasoning: {enabled: false}`), `low` and `high` are OpenRouter's
 * `reasoning.effort`. There is deliberately no `max` (nor `xhigh`): at its
 * top effort a model is far more verbose, and in Artificial Analysis'
 * measurements it almost never admits it doesn't know, the worst trade for
 * a learning app.
 */
export type ReasoningEffort = 'none' | 'low' | 'high';

/** Every `ReasoningEffort`, lowest first. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'low', 'high'];

/** Whether `value` is a `ReasoningEffort`. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Why a provider call is made; recorded with its usage for billing. */
export type UsagePurpose = 'reply' | 'summary' | 'title' | 'review' | 'other';

/** Attribution of one provider call (billing). Providers ignore it. */
export interface UsageTag {
  purpose: UsagePurpose;
  treeId: string;
  /** The branch the call serves (the one sent to, summarised for, titled or reviewed). */
  branchId: string | null;
  /** The node the call produces or is about (reply/review); null for summaries and titles. */
  nodeId: string | null;
  /**
   * The pending usage row reserved for this call before it was assembled (a
   * reply on the open pool or on Tangent credit). The meter sets that row's
   * hold to the call's exact worst case instead of reserving a second time.
   */
  reservationId?: string;
}

export interface GenerateRequest {
  model: string;
  system: string | null;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  signal: AbortSignal;
  /** Who/what the call is for; read by the Worker's usage meter, never sent upstream. */
  usageTag?: UsageTag;
  /** Offer (or require) a web search; ignored unless `capabilities(model).supportsWebSearch`. */
  webSearch?: WebSearchRequest;
  /**
   * Instructions for this reply only (e.g. how to use the web search tool),
   * sent after the history: appended to the last user message, as their own
   * text part after its cache breakpoint where the provider marks one, so a
   * turn with them and one without share the cached prefix (and the next
   * turn, whose history holds that message without them, still reads it).
   */
  turnInstructions?: string;
  /**
   * The reasoning effort of this call, overriding the model's configured
   * `ModelInfo.effort`: e.g. `none` for short structured answers whose output
   * cap thinking would use up (the pool's topic classifier), or the
   * background effort of summaries and titles. Absent = the model's
   * `effort`, else none sent. Sent only where the endpoint takes it
   * (OpenRouter); elsewhere ignored.
   */
  reasoning?: ReasoningEffort;
}

/**
 * A web search offered for one reply, as every provider with
 * `supportsWebSearch` honours it. How a search runs (OpenRouter's engine and
 * results per search) is the provider's own config.
 */
export interface WebSearchRequest {
  /**
   * `auto`: the model decides whether to search; `required`: it must search,
   * sent only to a provider that can enforce it (`requiredWebSearch`).
   */
  mode: 'auto' | 'required';
  /** Most searches in this reply. */
  maxUses: number;
}

export type ProviderErrorCode =
  /** The user's Tangent credit can't cover the call (the Worker's meter, before it is sent). */
  | 'payment_required'
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'invalid_request'
  | 'context_length'
  | 'aborted'
  | 'network'
  | 'server'
  | 'config'
  | 'unknown';

/**
 * How far a failed call got: `not_sent` (it failed before the request left,
 * e.g. a missing key or a connection error), `rejected` (the upstream answered
 * with a non-2xx status) or `stream` (it failed after a 2xx response, so the
 * upstream may have billed for it). Absent when unknown, e.g. on abort.
 */
export type ProviderUpstream = 'not_sent' | 'rejected' | 'stream';

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  /** HTTP status, if the error came from an HTTP response. */
  status?: number;
  retryable: boolean;
  /** Set by the HTTP providers (anthropic, openai-compatible); read by the open pool's settlement. */
  upstream?: ProviderUpstream;
}

/**
 * Token usage as a provider reports it: the totals, plus the prompt-cache
 * share of the input when the upstream reports it (absent = not reported).
 */
export interface ProviderUsage extends TokenUsage {
  /** Input tokens read from the prompt cache; included in `inputTokens`. */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache; included in `inputTokens`. */
  cacheWriteTokens: number;
  /** Output tokens spent thinking; included in `outputTokens`. */
  reasoningTokens: number;
}

/**
 * One event type for streaming, usage, completion and failure.
 *
 * Contract for `LlmProvider.stream`:
 * - never throws (also not on abort); failures are yielded as `error`;
 * - yields zero or more `delta`/`usage` events, then exactly one terminal
 *   `done` or `error` event, then finishes;
 * - `usage` may be yielded more than once; later values override earlier ones
 *   field by field (providers report cumulative numbers);
 * - aborting `signal` ends the stream promptly with `error{code:'aborted'}`;
 * - `billing` (upstream generation id, reported cost in USD, and the upstream
 *   provider that served the call, `servedBy`, e.g. OpenRouter's `DeepSeek`)
 *   may be yielded any number of times before the terminal event; later
 *   fields override earlier ones. Consumers that don't bill must ignore it;
 * - `done.stopReason` is the upstream's own finish reason (`stop`, `length`,
 *   `end_turn`, `max_tokens`, …); `isLengthStop` (stop-reason.ts) tells a
 *   reply cut off at its output cap;
 * - `citations` (sources a web search found and the reply cites) may be
 *   yielded any number of times; each carries the full, deduplicated list so
 *   far. `activity` reports that a web search started.
 */
export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: Partial<ProviderUsage> }
  | {
      type: 'billing';
      generationId?: string;
      costUsd?: number;
      webSearches?: number;
      servedBy?: string;
    }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'activity'; kind: 'web_search' }
  | { type: 'done'; stopReason: string | null }
  | { type: 'error'; error: ProviderError };

export interface LlmProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly label: string;
  models(): ModelInfo[];
  defaultModel(): string;
  capabilities(model: string): ProviderCapabilities;
  /**
   * `capabilities` with the model's real limits where the host can look them
   * up (the Worker: OpenRouter's catalog of context windows): they replace the
   * kind's built-in defaults and never raise a configured limit. Absent =
   * `capabilities` is all there is. ChatService budgets with it.
   */
  resolveCapabilities?(model: string): Promise<ProviderCapabilities>;
  stream(request: GenerateRequest): AsyncIterable<ProviderEvent>;
  /** Exact input-token count, when `capabilities(model).supportsTokenCount`. */
  countTokens?(
    request: Omit<GenerateRequest, 'signal'> & { signal?: AbortSignal },
  ): Promise<number>;
}

/**
 * Config-driven registration. One entry per provider *instance*; several
 * instances may share a kind (e.g. OpenAI and OpenRouter are both
 * `openai-compatible`).
 */
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  /** Overrides the kind's default endpoint (e.g. an AI Gateway URL, OpenRouter). */
  baseUrl?: string;
  /** Name of the secret/env var holding the API key (never the key itself). */
  apiKeySecret?: string;
  /** Extra static headers (e.g. `cf-aig-authorization` is taken from `extraHeaderSecrets`). */
  headers?: Record<string, string>;
  /** Header name → secret name, for secret-valued headers such as cf-aig-authorization. */
  extraHeaderSecrets?: Record<string, string>;
  models: ModelInfo[];
  defaultModel: string;
  /**
   * True when `models` are only suggestions: any model id the upstream knows
   * (matching OPEN_MODEL_ID_PATTERN) may be used, e.g. any OpenRouter model.
   * An unlisted model gets the provider-level capabilities below.
   */
  openModels?: boolean;
  /** Provider-level capability defaults; models may override. */
  maxContextTokens?: number;
  maxOutputTokens?: number;
  supportsSystemPrompt?: boolean;
  /** Kind-specific options (e.g. FakeProvider script). */
  options?: Record<string, unknown>;
}

/** What the browser learns about providers (no secrets, no URLs). */
export interface ProviderInfo {
  id: string;
  kind: ProviderKind;
  label: string;
  models: ModelInfo[];
  defaultModel: string;
  /** True when `models` are suggestions and any model id is accepted (ProviderConfig.openModels). */
  openModels: boolean;
  /** False when neither a user key nor the API key secret is present. */
  available: boolean;
  /** True when the user may supply their own key for this provider (bring-your-own-key). */
  acceptsUserKey: boolean;
  /** Where the key used for this provider comes from; null when it needs none or has none. */
  keySource: 'user' | 'server' | null;
  /** True when replies can be grounded with web search ("Check sources"); absent = false. */
  webSearch?: boolean;
  /**
   * True for a test provider whose replies are scripted (kind `fake`): it
   * needs no key and takes none, and a new tree's default route never
   * prefers it over a real provider. Absent = false.
   */
  scripted?: boolean;
  /**
   * Who pays for calls through this entry. Power lists the built-in endpoint
   * (`openrouter`) a second time with `credit` (Tangent credit, on the
   * operator's key) after the user's own providers; a branch picks an entry by
   * its provider id and funding. Absent = `own-key`; Learn's one entry has
   * none, since Learn pays per request.
   */
  funding?: BranchFunding;
}

/**
 * Shape of a model id accepted by an `openModels` provider (e.g.
 * `deepseek/deepseek-v4-pro`, `openai/gpt-5:online`): it bounds what a client
 * can put in the upstream request's `model` field.
 */
export const OPEN_MODEL_ID_PATTERN = /^[A-Za-z0-9][\w.\-:/]{0,199}$/;

/**
 * The model allowlist: a provider with no listed models takes any model, an
 * `openModels` provider any well-formed id, every other one only its listed ids.
 */
export function isModelAllowed(
  info: Pick<ProviderInfo, 'models' | 'openModels'>,
  model: string,
): boolean {
  if (info.models.some((m) => m.id === model)) return true;
  if (info.openModels) return OPEN_MODEL_ID_PATTERN.test(model);
  return info.models.length === 0;
}

/** Looks up configured provider instances. Implemented in @tangent/providers. */
export interface ProviderRegistry {
  /**
   * The provider configured as `providerId`; undefined when none is. One that
   * can't be used here (no key) is still returned, and its calls fail with a
   * `config` error that says why: a caller with another route to fall back on
   * asks `isProviderAvailable` first.
   */
  get(providerId: string): LlmProvider | undefined;
  list(): ProviderInfo[];
  /** First available provider (API key present), else the first configured. */
  defaultProviderId(): string;
}

/** Whether `registry` has `providerId` configured with what it needs to make calls (a key). */
export function isProviderAvailable(registry: ProviderRegistry, providerId: string): boolean {
  return registry.list().some((p) => p.id === providerId && p.available);
}
