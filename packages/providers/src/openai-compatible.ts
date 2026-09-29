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
  codeForStatus,
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
  resolveConfigHeaders,
  stripTrailingSlash,
} from './internal.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULTS = { maxContextTokens: 128_000, maxOutputTokens: 8192, supportsSystemPrompt: true };

type MaxTokensParam = 'max_tokens' | 'max_completion_tokens';

function defaultMaxTokensParam(baseUrl: string): MaxTokensParam {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
  } catch {
    return 'max_tokens';
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** In-stream `error` object (OpenRouter sends these with HTTP 200). */
function codeForStreamError(err: Record<string, unknown>, message: string): ProviderErrorCode {
  const code = err['code'];
  if (looksLikeContextLength(message, code)) return 'context_length';
  if (typeof code === 'number' && code >= 400) return codeForStatus(code);
  if (code === 'rate_limit_exceeded') return 'rate_limit';
  if (code === 'invalid_api_key') return 'auth';
  return 'server';
}

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
  const baseUrl = stripTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
  const doFetch = getFetch(env);
  const optParam = config.options?.['maxTokensParam'];
  const maxTokensParam: MaxTokensParam =
    optParam === 'max_tokens' || optParam === 'max_completion_tokens' ? optParam : defaultMaxTokensParam(baseUrl);

  const capabilities = (model: string) => resolveCapabilities(config, model, DEFAULTS, false);

  function stream(request: GenerateRequest): AsyncIterable<ProviderEvent> {
    const resolved = resolveConfigHeaders(config, env);
    const secrets = [...resolved.secrets];
    let missing = resolved.missing;
    const headers = resolved.headers;
    if (config.apiKeySecret) {
      const key = env.secrets[config.apiKeySecret];
      if (key) {
        headers['authorization'] = `Bearer ${key}`;
        secrets.push(key);
      } else {
        missing ??= config.apiKeySecret;
      }
    }
    headers['content-type'] = 'application/json';

    return guardStream(request.signal, secrets, async function* () {
      if (missing !== undefined) throw new ProviderFailure(missingSecretError(missing));
      const { signal } = request;
      const caps = capabilities(request.model);

      const messages: { role: string; content: string }[] = request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      if (request.system !== null) {
        const first = messages[0];
        if (caps.supportsSystemPrompt || !first || first.role !== 'user') {
          messages.unshift({ role: 'system', content: request.system });
        } else {
          first.content = `${request.system}\n\n${first.content}`;
        }
      }
      const body: Record<string, unknown> = {
        model: request.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        [maxTokensParam]: request.maxOutputTokens ?? caps.maxOutputTokens,
      };

      let res: Response;
      try {
        res = await abortable(
          doFetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
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

      let finishReason: string | null = null;
      let sawFinish = false;
      for await (const msg of parseSse(res.body, signal)) {
        const raw = msg.data.trim();
        if (raw === '[DONE]') {
          yield { type: 'done', stopReason: finishReason };
          return;
        }
        let chunk: unknown;
        try {
          chunk = JSON.parse(raw);
        } catch {
          throw new ProviderFailure(providerError('unknown', 'Malformed chunk from provider'));
        }
        if (!isRecord(chunk)) continue;

        const err = chunk['error'];
        if (isRecord(err) || typeof err === 'string') {
          const errRec = isRecord(err) ? err : {};
          const message = typeof err === 'string' ? err : typeof errRec['message'] === 'string' ? errRec['message'] : 'Provider stream error';
          yield { type: 'error', error: providerError(codeForStreamError(errRec, message), redact(message, secrets)) };
          return;
        }

        const choices = chunk['choices'];
        const choice = Array.isArray(choices) ? (choices[0] as unknown) : undefined;
        if (isRecord(choice)) {
          const delta = choice['delta'];
          if (isRecord(delta) && typeof delta['content'] === 'string' && delta['content'] !== '') {
            yield { type: 'delta', text: delta['content'] };
          }
          const fr = choice['finish_reason'];
          if (typeof fr === 'string') {
            finishReason = fr;
            sawFinish = true;
          }
        }

        const usage = chunk['usage'];
        if (isRecord(usage)) {
          const u: Partial<TokenUsage> = {};
          const input = num(usage['prompt_tokens']);
          if (input !== undefined) u.inputTokens = input;
          const output = num(usage['completion_tokens']);
          if (output !== undefined) u.outputTokens = output;
          if (Object.keys(u).length > 0) yield { type: 'usage', usage: u };
        }
      }
      // No [DONE]: fine if the model finished; otherwise guardStream reports truncation.
      if (sawFinish) yield { type: 'done', stopReason: finishReason };
    });
  }

  return {
    id: config.id,
    kind: 'openai-compatible',
    label: config.label,
    models: () => config.models.map((m) => ({ ...m })),
    defaultModel: () => config.defaultModel,
    capabilities,
    stream,
  };
}
