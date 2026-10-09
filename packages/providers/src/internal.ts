/**
 * Helpers shared by the provider implementations. Not part of the public
 * package API (not re-exported from index.ts).
 */
import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderErrorCode,
  ProviderEvent,
} from '@tangent/shared';
import { clip, isReasoningModel, REASONING_MAX_OUTPUT_TOKENS } from '@tangent/shared';
import type { ProviderEnv } from './registry.js';

/** Thrown inside provider internals; converted to an `error` event by `guardStream`. */
export class ProviderFailure extends Error {
  readonly error: ProviderError;
  constructor(error: ProviderError) {
    super(error.message);
    this.name = 'ProviderFailure';
    this.error = error;
  }
}

export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function abortedProviderError(): ProviderError {
  return { code: 'aborted', message: 'Request aborted', retryable: false };
}

/**
 * Resolves/rejects like `promise`, but rejects with an AbortError as soon as
 * `signal` aborts (even if `promise` never settles, e.g. a fetch that ignores
 * its signal). The abort listener is removed once settled.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      promise.catch(() => undefined);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Abortable sleep. */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const p = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return abortable(p, signal).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'rate_limit',
  'overloaded',
  'network',
  'server',
]);

export function isRetryable(code: ProviderErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function providerError(
  code: ProviderErrorCode,
  message: string,
  status?: number,
): ProviderError {
  const error: ProviderError = { code, message, retryable: isRetryable(code) };
  if (status !== undefined) error.status = status;
  return error;
}

const CONTEXT_LENGTH_RE =
  /context[ _-]?(length|window)|maximum context|prompt is too long|input is too long|too many (input )?tokens|exceeds? the (model'?s? )?(maximum|max)|context_length_exceeded/i;

export function looksLikeContextLength(message: string, code?: unknown): boolean {
  if (code === 'context_length_exceeded') return true;
  return CONTEXT_LENGTH_RE.test(message);
}

/** HTTP status → error code (without looking at the body). */
export function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 529 || status === 503) return 'overloaded';
  if (status === 408) return 'network';
  if (status >= 500) return 'server';
  if (status >= 400) return 'invalid_request';
  return 'unknown';
}

/** Removes secret values (and anything that looks like an API key) from text. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join('[redacted]');
  }
  return out.replace(/\b(sk-[A-Za-z0-9_*-]{3})[A-Za-z0-9_*-]{5,}/g, '$1…[redacted]');
}

/** The longest provider error message passed on. */
const ERROR_MESSAGE_MAX = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Pulls `{error:{message,type,code}}` (or `{error:"..."}`, `{message}`) out of a parsed body. */
export function extractErrorInfo(body: unknown): {
  message?: string;
  type?: string;
  code?: unknown;
} {
  if (!isRecord(body)) return {};
  const err = body['error'];
  if (isRecord(err)) {
    const out: { message?: string; type?: string; code?: unknown } = {};
    if (typeof err['message'] === 'string') out.message = err['message'];
    if (typeof err['type'] === 'string') out.type = err['type'];
    if (err['code'] !== undefined && err['code'] !== null) out.code = err['code'];
    return out;
  }
  if (typeof err === 'string') return { message: err };
  if (typeof body['message'] === 'string') return { message: body['message'] };
  return {};
}

/** Maps a non-2xx response to a ProviderError, reading (and parsing) its body. */
export async function errorFromResponse(
  res: Response,
  signal: AbortSignal | undefined,
  secrets: readonly string[],
): Promise<ProviderError> {
  let text = '';
  try {
    text = await abortable(res.text(), signal);
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  let info: { message?: string; type?: string; code?: unknown } = {};
  try {
    info = extractErrorInfo(JSON.parse(text));
  } catch {
    // not JSON
  }
  const status = res.status;
  let code = codeForStatus(status);
  const raw =
    info.message ?? (text.trim() || `HTTP ${status}${res.statusText ? ` ${res.statusText}` : ''}`);
  if (info.type === 'overloaded_error') code = 'overloaded';
  if ((code === 'invalid_request' || status === 413) && looksLikeContextLength(raw, info.code)) {
    code = 'context_length';
  }
  return providerError(code, clip(redact(raw, secrets), ERROR_MESSAGE_MAX), status);
}

export function networkError(err: unknown, secrets: readonly string[]): ProviderError {
  const msg = err instanceof Error ? err.message : String(err);
  return providerError(
    'network',
    clip(redact(`Network error: ${msg}`, secrets), ERROR_MESSAGE_MAX),
  );
}

/**
 * Enforces the `LlmProvider.stream` contract around an inner generator that
 * may throw: forwards events, stops after the first terminal event, maps
 * exceptions to `error` (aborted when the signal fired), and turns a
 * premature end into a network error.
 */
export async function* guardStream(
  signal: AbortSignal,
  secrets: readonly string[],
  inner: () => AsyncGenerator<ProviderEvent>,
): AsyncGenerator<ProviderEvent> {
  if (signal.aborted) {
    yield { type: 'error', error: abortedProviderError() };
    return;
  }
  let terminal: ProviderEvent | null = null;
  const it = inner();
  try {
    for (;;) {
      let step: IteratorResult<ProviderEvent>;
      try {
        step = await it.next();
      } catch (e) {
        if (signal.aborted) terminal = { type: 'error', error: abortedProviderError() };
        else if (e instanceof ProviderFailure) terminal = { type: 'error', error: e.error };
        else if (e instanceof TypeError)
          terminal = { type: 'error', error: networkError(e, secrets) };
        else {
          const msg = e instanceof Error ? e.message : String(e);
          terminal = {
            type: 'error',
            error: providerError('unknown', clip(redact(msg, secrets), ERROR_MESSAGE_MAX)),
          };
        }
        break;
      }
      if (step.done) break;
      const ev = step.value;
      if (ev.type === 'done' || ev.type === 'error') {
        terminal = ev;
        break;
      }
      if (signal.aborted) {
        terminal = { type: 'error', error: abortedProviderError() };
        break;
      }
      yield ev;
    }
  } finally {
    // Release the inner generator (and with it the response body reader).
    void it.return(undefined).catch(() => undefined);
  }
  if (!terminal) {
    terminal = signal.aborted
      ? { type: 'error', error: abortedProviderError() }
      : { type: 'error', error: providerError('network', 'stream ended unexpectedly') };
  }
  yield terminal;
}

export function resolveCapabilities(
  config: ProviderConfig,
  model: string,
  defaults: { maxContextTokens: number; maxOutputTokens: number; supportsSystemPrompt: boolean },
  supportsTokenCount: boolean,
): ProviderCapabilities {
  const m: ModelInfo | undefined = config.models.find((x) => x.id === model);
  const reasoning = m?.reasoning ?? isReasoningModel(model);
  // A reasoning model's thinking counts as output: without a configured limit, it may
  // write up to REASONING_MAX_OUTPUT_TOKENS (a reply's cap is set by ChatService).
  const defaultMaxOutput = reasoning
    ? Math.max(defaults.maxOutputTokens, REASONING_MAX_OUTPUT_TOKENS)
    : defaults.maxOutputTokens;
  return {
    maxContextTokens: m?.maxContextTokens ?? config.maxContextTokens ?? defaults.maxContextTokens,
    maxOutputTokens: m?.maxOutputTokens ?? config.maxOutputTokens ?? defaultMaxOutput,
    supportsSystemPrompt: config.supportsSystemPrompt ?? defaults.supportsSystemPrompt,
    supportsTokenCount,
    supportsWebSearch: config.options?.['webSearch'] === true,
    reasoning,
  };
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export interface ResolvedHeaders {
  headers: Record<string, string>;
  /** Secret values used (for redaction). */
  secrets: string[];
  /** Name of the first missing secret, if any. */
  missing?: string;
}

/**
 * Static config headers + secret-valued headers (extraHeaderSecrets). The
 * provider's own auth headers are applied on top by the caller.
 */
export function resolveConfigHeaders(config: ProviderConfig, env: ProviderEnv): ResolvedHeaders {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  const secrets: string[] = [];
  let missing: string | undefined;
  for (const [header, secretName] of Object.entries(config.extraHeaderSecrets ?? {})) {
    const value = env.secrets[secretName];
    if (value) {
      headers[header] = value;
      secrets.push(value);
    } else {
      missing ??= secretName;
    }
  }
  const out: ResolvedHeaders = { headers, secrets };
  if (missing !== undefined) out.missing = missing;
  return out;
}

/**
 * The API key for `config`: the caller-supplied key for this provider id
 * (bring-your-own-key) wins over the configured secret.
 */
export function resolveApiKey(config: ProviderConfig, env: ProviderEnv): string | undefined {
  const own = env.apiKeys?.[config.id];
  if (own) return own;
  return config.apiKeySecret ? env.secrets[config.apiKeySecret] || undefined : undefined;
}

export function getFetch(env: ProviderEnv): typeof fetch {
  return env.fetch ?? ((input, init) => globalThis.fetch(input, init));
}

export function missingSecretError(name: string): ProviderError {
  return providerError('config', `Missing secret ${name}`);
}

export { isRecord };
