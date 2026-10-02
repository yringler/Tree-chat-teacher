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
  resolveApiKey,
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

/** Keys of the request body that `options.extraBody` may not override. */
const PROTECTED_BODY_KEYS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'stream',
  'max_tokens',
  'max_completion_tokens',
]);

/** `options.extraBody` minus the protected keys (empty when absent or not an object). */
function readExtraBody(options: Record<string, unknown> | undefined): Record<string, unknown> {
  const raw = options?.['extraBody'];
  const out: Record<string, unknown> = {};
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (!PROTECTED_BODY_KEYS.has(k)) out[k] = v;
  return out;
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
 * options.extraBody: JSON object merged into the request body (e.g.
 * `{"reasoning": {"effort": "low"}}`); it cannot override `model`,
 * `messages`, `stream`, `max_tokens` or `max_completion_tokens` (it may
 * replace `stream_options`).
 *
 * Billing (OpenRouter): yields `{type:'billing', generationId}` right after a
 * 2xx response when the `x-generation-id` header is present (before any
 * delta), otherwise once for the first chunk whose `id` starts with `gen-`;
 * and `{type:'billing', costUsd}` when a chunk's `usage.cost` is a number.
 */
export function createOpenAiCompatibleProvider(config: ProviderConfig, env: ProviderEnv): LlmProvider {
  const baseUrl = stripTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
  const doFetch = getFetch(env);
  const optParam = config.options?.['maxTokensParam'];
  const maxTokensParam: MaxTokensParam =
    optParam === 'max_tokens' || optParam === 'max_completion_tokens' ? optParam : defaultMaxTokensParam(baseUrl);
  const extraBody = readExtraBody(config.options);

  const capabilities = (model: string) => resolveCapabilities(config, model, DEFAULTS, false);

  function stream(request: GenerateRequest): AsyncIterable<ProviderEvent> {
    const resolved = resolveConfigHeaders(config, env);
    const secrets = [...resolved.secrets];
    let missing = resolved.missing;
    const headers = resolved.headers;
    const key = resolveApiKey(config, env);
    if (key) {
      headers['authorization'] = `Bearer ${key}`;
      secrets.push(key);
    } else if (config.apiKeySecret) {
      missing ??= config.apiKeySecret;
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
        stream_options: { include_usage: true },
        ...extraBody,
        model: request.model,
        messages,
        stream: true,
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

      const headerId = res.headers.get('x-generation-id')?.trim();
      let generationId: string | undefined = headerId || undefined;
      if (generationId !== undefined) yield { type: 'billing', generationId };

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

        const chunkId = chunk['id'];
        if (generationId === undefined && typeof chunkId === 'string' && chunkId.startsWith('gen-')) {
          generationId = chunkId;
          yield { type: 'billing', generationId };
        }

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
          const costUsd = num(usage['cost']);
          if (costUsd !== undefined) yield { type: 'billing', costUsd };
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
