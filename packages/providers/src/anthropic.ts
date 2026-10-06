import type {
  GenerateRequest,
  LlmProvider,
  ProviderConfig,
  ProviderErrorCode,
  ProviderEvent,
  TokenUsage,
} from '@tangent/shared';
import type { ProviderEnv } from './registry.js';
import { parseSse } from './sse.js';
import {
  ProviderFailure,
  abortable,
  errorFromResponse,
  getFetch,
  guardStream,
  isRecord,
  looksLikeContextLength,
  missingSecretError,
  networkError,
  providerError,
  redact,
  resolveCapabilities,
  resolveApiKey,
  resolveConfigHeaders,
  stripTrailingSlash,
} from './internal.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULTS = { maxContextTokens: 200_000, maxOutputTokens: 8192, supportsSystemPrompt: true };

/** Anthropic `error.type` → our code. */
function codeForAnthropicType(type: string | undefined, message: string): ProviderErrorCode {
  switch (type) {
    case 'overloaded_error':
      return 'overloaded';
    case 'rate_limit_error':
      return 'rate_limit';
    case 'authentication_error':
    case 'permission_error':
      return 'auth';
    case 'invalid_request_error':
    case 'request_too_large':
    case 'not_found_error':
      return looksLikeContextLength(message) ? 'context_length' : 'invalid_request';
    case 'api_error':
    case 'timeout_error':
      return 'server';
    default:
      return 'unknown';
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Total input tokens (uncached + cache writes + cache reads), if reported. */
function inputTokensOf(usage: Record<string, unknown>): number | undefined {
  const base = num(usage['input_tokens']);
  if (base === undefined) return undefined;
  return base + (num(usage['cache_creation_input_tokens']) ?? 0) + (num(usage['cache_read_input_tokens']) ?? 0);
}

/**
 * Anthropic Messages API over raw fetch + SSE (POST {baseUrl}/v1/messages,
 * `anthropic-version: 2023-06-01`). Default baseUrl https://api.anthropic.com;
 * set baseUrl to an AI Gateway URL (…/{account}/{gateway}/anthropic) to route
 * through Cloudflare AI Gateway. Implements countTokens via
 * /v1/messages/count_tokens. Does not send `temperature` or assistant prefill.
 */
export function createAnthropicProvider(config: ProviderConfig, env: ProviderEnv): LlmProvider {
  const baseUrl = stripTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
  const doFetch = getFetch(env);

  // Anthropic's own web_search tool is not wired up (docs/DEFERRED.md).
  const capabilities = (model: string) => ({
    ...resolveCapabilities(config, model, DEFAULTS, true),
    supportsWebSearch: false,
  });

  /** Request headers, or a missing-secret name. */
  const buildHeaders = (): { headers: Record<string, string>; secrets: string[] } | { missing: string } => {
    const resolved = resolveConfigHeaders(config, env);
    if (resolved.missing !== undefined) return { missing: resolved.missing };
    const headers = resolved.headers;
    const secrets = [...resolved.secrets];
    const key = resolveApiKey(config, env);
    if (key) {
      headers['x-api-key'] = key;
      secrets.push(key);
    } else if (config.apiKeySecret) {
      return { missing: config.apiKeySecret };
    }
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    headers['content-type'] = 'application/json';
    return { headers, secrets };
  };

  const messagesOf = (request: Pick<GenerateRequest, 'messages'>) =>
    request.messages.map((m) => ({ role: m.role, content: m.content }));

  function stream(request: GenerateRequest): AsyncIterable<ProviderEvent> {
    const built = buildHeaders();
    const secrets = 'secrets' in built ? built.secrets : [];
    return guardStream(request.signal, secrets, async function* () {
      if ('missing' in built) throw new ProviderFailure(missingSecretError(built.missing));
      const { signal } = request;
      const body: Record<string, unknown> = {
        model: request.model,
        max_tokens: request.maxOutputTokens ?? capabilities(request.model).maxOutputTokens,
      };
      if (request.system !== null) body['system'] = request.system;
      body['messages'] = messagesOf(request);
      body['stream'] = true;

      let res: Response;
      try {
        res = await abortable(
          doFetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: built.headers,
            body: JSON.stringify(body),
            signal,
          }),
          signal,
        );
      } catch (e) {
        if (signal.aborted) throw e;
        throw new ProviderFailure(networkError(e, secrets));
      }
      if (!res.ok) throw new ProviderFailure(await errorFromResponse(res, signal, secrets));
      if (!res.body) throw new ProviderFailure(providerError('network', 'Response has no body'));

      let stopReason: string | null = null;
      for await (const msg of parseSse(res.body, signal)) {
        let data: unknown;
        try {
          data = JSON.parse(msg.data);
        } catch {
          throw new ProviderFailure(providerError('unknown', `Malformed ${msg.event} event from provider`));
        }
        if (!isRecord(data)) continue;
        const type = typeof data['type'] === 'string' ? data['type'] : msg.event;
        switch (type) {
          case 'message_start': {
            const message = data['message'];
            const usage = isRecord(message) ? message['usage'] : undefined;
            if (isRecord(usage)) {
              const u: Partial<TokenUsage> = {};
              const input = inputTokensOf(usage);
              if (input !== undefined) u.inputTokens = input;
              const output = num(usage['output_tokens']);
              if (output !== undefined) u.outputTokens = output;
              if (Object.keys(u).length > 0) yield { type: 'usage', usage: u };
            }
            break;
          }
          case 'content_block_delta': {
            const delta = data['delta'];
            if (isRecord(delta) && delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
              if (delta['text'] !== '') yield { type: 'delta', text: delta['text'] };
            }
            break;
          }
          case 'message_delta': {
            const delta = data['delta'];
            if (isRecord(delta) && typeof delta['stop_reason'] === 'string') stopReason = delta['stop_reason'];
            const usage = data['usage'];
            if (isRecord(usage)) {
              const u: Partial<TokenUsage> = {};
              const output = num(usage['output_tokens']);
              if (output !== undefined) u.outputTokens = output;
              const input = inputTokensOf(usage);
              if (input !== undefined) u.inputTokens = input;
              if (Object.keys(u).length > 0) yield { type: 'usage', usage: u };
            }
            break;
          }
          case 'message_stop':
            yield { type: 'done', stopReason };
            return;
          case 'error': {
            const err = data['error'];
            const errType = isRecord(err) && typeof err['type'] === 'string' ? err['type'] : undefined;
            const rawMessage =
              isRecord(err) && typeof err['message'] === 'string' ? err['message'] : 'Provider stream error';
            const code = codeForAnthropicType(errType, rawMessage);
            yield { type: 'error', error: providerError(code, redact(rawMessage, secrets)) };
            return;
          }
          default:
            // ping, content_block_start/stop and unknown events.
            break;
        }
      }
      // Stream ended without message_stop: guardStream reports it.
    });
  }

  async function countTokens(request: Omit<GenerateRequest, 'signal'> & { signal?: AbortSignal }): Promise<number> {
    const built = buildHeaders();
    if ('missing' in built) throw new ProviderFailure(missingSecretError(built.missing));
    const body: Record<string, unknown> = { model: request.model };
    if (request.system !== null) body['system'] = request.system;
    body['messages'] = messagesOf(request);
    const init: RequestInit = { method: 'POST', headers: built.headers, body: JSON.stringify(body) };
    if (request.signal) init.signal = request.signal;
    let res: Response;
    try {
      res = await abortable(doFetch(`${baseUrl}/v1/messages/count_tokens`, init), request.signal);
    } catch (e) {
      if (request.signal?.aborted) throw e;
      throw new ProviderFailure(networkError(e, built.secrets));
    }
    if (!res.ok) throw new ProviderFailure(await errorFromResponse(res, request.signal, built.secrets));
    const json: unknown = await abortable(res.json(), request.signal);
    const n = isRecord(json) ? num(json['input_tokens']) : undefined;
    if (n === undefined) throw new ProviderFailure(providerError('unknown', 'count_tokens returned no input_tokens'));
    return n;
  }

  return {
    id: config.id,
    kind: 'anthropic',
    label: config.label,
    models: () => config.models.map((m) => ({ ...m })),
    defaultModel: () => config.defaultModel,
    capabilities,
    stream,
    countTokens,
  };
}
