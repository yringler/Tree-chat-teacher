import type { ChatMessage } from './context-plan.js';
import type { TokenUsage } from './domain.js';

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
}

export interface ModelInfo {
  id: string;
  label: string;
  /** Overrides the provider-level capability defaults for this model. */
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

export interface GenerateRequest {
  model: string;
  system: string | null;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  signal: AbortSignal;
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

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  /** HTTP status, if the error came from an HTTP response. */
  status?: number;
  retryable: boolean;
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
 * - aborting `signal` ends the stream promptly with `error{code:'aborted'}`.
 */
export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: Partial<TokenUsage> }
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
  countTokens?(request: Omit<GenerateRequest, 'signal'> & { signal?: AbortSignal }): Promise<number>;
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
  /** False when the API key secret is missing. */
  available: boolean;
}

/** Looks up configured provider instances. Implemented in @tangent/providers. */
export interface ProviderRegistry {
  get(providerId: string): LlmProvider | undefined;
  list(): ProviderInfo[];
  /** First available provider (API key present), else the first configured. */
  defaultProviderId(): string;
}
