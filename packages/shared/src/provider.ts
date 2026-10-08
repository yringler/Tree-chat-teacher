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
   * True for a reasoning model (`ModelInfo.reasoning`, else `isReasoningModel`):
   * its thinking counts as output, so replies get a larger cap (output-tokens.ts).
   * Absent = false.
   */
  reasoning?: boolean;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** Overrides the provider-level capability defaults for this model. */
  maxContextTokens?: number;
  maxOutputTokens?: number;
  /** Whether the model reasons (thinks before answering); absent = `isReasoningModel(id)`. */
  reasoning?: boolean;
}

/**
 * Why a provider call is made; recorded with its usage for billing.
 * `tagging` is the open pool's topic classifier (charged to the pool).
 */
export type UsagePurpose = 'reply' | 'summary' | 'title' | 'review' | 'tagging' | 'other';

/** Attribution of one provider call (billing). Providers ignore it. */
export interface UsageTag {
  purpose: UsagePurpose;
  treeId: string;
  /** The branch the call serves (the one sent to, summarised for, titled or reviewed). */
  branchId: string | null;
  /** The node the call produces or is about (reply/review); null for summaries and titles. */
  nodeId: string | null;
  /**
   * Open pool only: the pending usage row reserved for this call before
   * it was assembled (the reply's ceiling hold). The meter shrinks that row's
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
}

/** A web search offered for one reply (OpenRouter's `openrouter:web_search` server tool). */
export interface WebSearchRequest {
  /** `auto`: the model decides whether to search; `required`: it must search. */
  mode: 'auto' | 'required';
  /** Results per search. */
  maxResults: number;
  /** Most searches in this reply. */
  maxUses: number;
  /** Search engine (OpenRouter: `exa`, `parallel`, `auto`, …). */
  engine: string;
}

export type ProviderErrorCode =
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
  /** Set by providers that know it (openai-compatible); read by the open pool's settlement. */
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
 * - `billing` (upstream generation id and/or reported cost in USD) may be
 *   yielded any number of times before the terminal event; later fields
 *   override earlier ones. Consumers that don't bill must ignore it;
 * - `citations` (sources a web search found and the reply cites) may be
 *   yielded any number of times; each carries the full, deduplicated list so
 *   far. `activity` reports that a web search started.
 */
export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: Partial<ProviderUsage> }
  | { type: 'billing'; generationId?: string; costUsd?: number; webSearches?: number }
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
  get(providerId: string): LlmProvider | undefined;
  list(): ProviderInfo[];
  /** First available provider (API key present), else the first configured. */
  defaultProviderId(): string;
}
