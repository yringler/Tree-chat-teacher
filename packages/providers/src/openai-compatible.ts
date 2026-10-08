import {
  CITATIONS_MAX,
  CITATION_EXCERPT_MAX,
  isCitableUrl,
  type Citation,
  type GenerateRequest,
  type LlmProvider,
  type ProviderConfig,
  type ProviderErrorCode,
  type ProviderEvent,
  type ProviderUsage,
  type ReasoningEffort,
  type WebSearchRequest,
} from '@tangent/shared';
import {
  isOpenRouterBaseUrl,
  markLastMessage,
  promptCacheOption,
  usesExplicitCacheControl,
  withBreakpoint,
  withTurnInstructions,
} from './prompt-cache.js';
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

/** Body keys a web search sets; `extraBody` can't override them while one is requested. */
const WEB_SEARCH_BODY_KEYS: readonly string[] = ['tools', 'tool_choice', 'plugins'];

/** OpenRouter's web search server tool (https://openrouter.ai/docs/guides/features/server-tools/web-search). */
function webSearchBody(ws: WebSearchRequest): Record<string, unknown> {
  return {
    tools: [
      {
        type: 'openrouter:web_search',
        parameters: { engine: ws.engine, max_results: ws.maxResults, max_uses: ws.maxUses },
      },
    ],
    tool_choice: ws.mode === 'required' ? 'required' : 'auto',
  };
}

/** OpenRouter's `reasoning` object for an effort: `none` turns thinking off. */
function reasoningBody(effort: ReasoningEffort): Record<string, unknown> {
  return effort === 'none' ? { enabled: false } : { effort };
}

/**
 * OpenRouter's `provider` routing with `order` pinned first: merged into the
 * operator's own routing from `extraBody` (e.g. the open pool's `max_price`,
 * `data_collection`), whose explicit `allow_fallbacks` wins; fallbacks are
 * allowed otherwise, so an outage of the pinned upstream doesn't fail the call.
 */
function pinnedRouting(routing: unknown, order: readonly string[]): Record<string, unknown> {
  return { allow_fallbacks: true, ...(isRecord(routing) ? routing : {}), order: [...order] };
}

/**
 * Adds the `url_citation` annotations in `raw` to `into` (deduplicated by
 * URL, http(s) only, excerpt clipped). Returns true if anything was added.
 */
function collectCitations(raw: unknown, into: Map<string, Citation>): boolean {
  if (!Array.isArray(raw)) return false;
  let added = false;
  for (const a of raw) {
    if (!isRecord(a) || a['type'] !== 'url_citation') continue;
    const c = a['url_citation'];
    if (!isRecord(c) || typeof c['url'] !== 'string') continue;
    const url = c['url'].trim();
    if (!isCitableUrl(url) || into.has(url) || into.size >= CITATIONS_MAX) continue;
    const title =
      typeof c['title'] === 'string' && c['title'].trim() ? c['title'].trim().slice(0, 500) : null;
    const content =
      typeof c['content'] === 'string' ? c['content'].replace(/\s+/g, ' ').trim() : '';
    const excerpt = content
      ? content.length > CITATION_EXCERPT_MAX
        ? `${content.slice(0, CITATION_EXCERPT_MAX - 1)}…`
        : content
      : null;
    into.set(url, { url, title, excerpt });
    added = true;
  }
  return added;
}

/** True when a streamed `tool_calls` delta names the web search tool. */
function isWebSearchCall(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((t) => {
    if (!isRecord(t)) return false;
    const fn = t['function'];
    const name = isRecord(fn) ? fn['name'] : t['type'];
    return typeof name === 'string' && name.includes('web_search');
  });
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * A chunk's `usage` as our usage fields (only those reported). `prompt_tokens`
 * includes cached tokens; the cache share is `prompt_tokens_details`
 * (`cached_tokens`, and OpenRouter's `cache_write_tokens`), or DeepSeek's own
 * `prompt_cache_hit_tokens`. `completion_tokens` includes the thinking,
 * `completion_tokens_details.reasoning_tokens`.
 */
function usageOf(usage: Record<string, unknown>): Partial<ProviderUsage> {
  const u: Partial<ProviderUsage> = {};
  const input = num(usage['prompt_tokens']);
  if (input !== undefined) u.inputTokens = input;
  const output = num(usage['completion_tokens']);
  if (output !== undefined) u.outputTokens = output;
  const completion = usage['completion_tokens_details'];
  const reasoning = isRecord(completion) ? num(completion['reasoning_tokens']) : undefined;
  if (reasoning !== undefined) u.reasoningTokens = reasoning;
  const details = usage['prompt_tokens_details'];
  const read =
    (isRecord(details) ? num(details['cached_tokens']) : undefined) ??
    num(usage['prompt_cache_hit_tokens']);
  if (read !== undefined) u.cacheReadTokens = read;
  const write = isRecord(details) ? num(details['cache_write_tokens']) : undefined;
  if (write !== undefined) u.cacheWriteTokens = write;
  return u;
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
 * Web search (OpenRouter, when `options.webSearch` is true and the request
 * has `webSearch`): sends the `openrouter:web_search` server tool with
 * `tool_choice` auto/required; `extraBody` can't override `tools`,
 * `tool_choice` or `plugins` then. `url_citation` annotations (in
 * `delta.annotations` or `message.annotations`) become `citations` events, a
 * streamed web-search tool call an `activity` event, and
 * `usage.server_tool_use.web_search_requests` a `billing.webSearches`.
 *
 * Billing (OpenRouter): yields `{type:'billing', generationId}` right after a
 * 2xx response when the `x-generation-id` header is present (before any
 * delta), otherwise once for the first chunk whose `id` starts with `gen-`;
 * and `{type:'billing', costUsd}` when a chunk's `usage.cost` is a number.
 *
 * Reasoning and routing (OpenRouter only; other endpoints may reject the
 * fields): the call's effort (`request.reasoning`, else the model's
 * `ModelInfo.effort`) is sent as `reasoning: {effort}` (`none`:
 * `{enabled: false}`), replacing any `reasoning` in `extraBody`; nothing is
 * sent when neither names one. A model's `providerOrder` is sent as
 * `provider.order` with `allow_fallbacks: true`, merged into `extraBody`'s
 * `provider` (the open pool's `max_price` stays). The thinking itself is
 * never read: only `delta.content` becomes text, so streamed
 * `delta.reasoning` / `reasoning_details` are dropped here, never shown,
 * stored or sent back (it is not asked to be excluded: `reasoning.exclude`
 * changes nothing billed, and the stream stays the same with or without
 * an effort). Each chunk's `provider` (the upstream that served the call)
 * is yielded once as `billing.servedBy`.
 *
 * Prompt caching (prompt-cache.ts): for models that cache only with explicit
 * markers (Anthropic's, `anthropic/…`) on OpenRouter, the system message and
 * the latest message become content-part arrays with a `cache_control`
 * breakpoint; other models and endpoints get plain string content (they cache
 * automatically, or a strict API could reject the field).
 * `request.turnInstructions` follow the latest message (`withTurnInstructions`):
 * a separate part after its breakpoint, or appended to its plain text.
 * `options.promptCache`: false never marks; true marks on any endpoint (one
 * known to accept `cache_control`, e.g. a proxy in front of OpenRouter), still
 * only for explicit-cache models. Usage reports the cache reads and writes
 * (`prompt_tokens_details`).
 *
 * Error events say how far the call got (`ProviderError.upstream`): `not_sent`
 * (missing key, connection failure), `rejected` (non-2xx response) or
 * `stream` (failed after a 2xx response). The open pool releases a
 * reservation in full only for the first two.
 */
export function createOpenAiCompatibleProvider(
  config: ProviderConfig,
  env: ProviderEnv,
): LlmProvider {
  const baseUrl = stripTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
  const doFetch = getFetch(env);
  const optParam = config.options?.['maxTokensParam'];
  const maxTokensParam: MaxTokensParam =
    optParam === 'max_tokens' || optParam === 'max_completion_tokens'
      ? optParam
      : defaultMaxTokensParam(baseUrl);
  const extraBody = readExtraBody(config.options);
  const openRouter = isOpenRouterBaseUrl(baseUrl);
  const promptCache = promptCacheOption(config.options) ?? openRouter;

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
      if (missing !== undefined)
        throw new ProviderFailure({ ...missingSecretError(missing), upstream: 'not_sent' });
      const { signal } = request;
      const caps = capabilities(request.model);

      const plain: { role: string; content: string }[] = request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      let system: string | null = null;
      if (request.system !== null) {
        const first = plain[0];
        if (caps.supportsSystemPrompt || !first || first.role !== 'user') {
          system = request.system;
        } else {
          first.content = `${request.system}\n\n${first.content}`;
        }
      }
      const cache = promptCache && usesExplicitCacheControl(request.model);
      const messages = withTurnInstructions(
        cache ? markLastMessage(plain) : plain,
        request.turnInstructions,
      );
      if (system !== null) {
        messages.unshift({ role: 'system', content: cache ? withBreakpoint(system) : system });
      }
      const webSearch = request.webSearch && caps.supportsWebSearch ? request.webSearch : null;
      const extra = webSearch
        ? Object.fromEntries(
            Object.entries(extraBody).filter(([k]) => !WEB_SEARCH_BODY_KEYS.includes(k)),
          )
        : extraBody;
      const listed = config.models.find((m) => m.id === request.model);
      const effort = request.reasoning ?? listed?.effort;
      const order = listed?.providerOrder ?? [];
      const body: Record<string, unknown> = {
        stream_options: { include_usage: true },
        ...extra,
        ...(webSearch ? webSearchBody(webSearch) : {}),
        ...(openRouter && effort !== undefined ? { reasoning: reasoningBody(effort) } : {}),
        ...(openRouter && order.length > 0
          ? { provider: pinnedRouting(extra['provider'], order) }
          : {}),
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
        throw new ProviderFailure({ ...networkError(e, secrets), upstream: 'not_sent' });
      }
      if (!res.ok)
        throw new ProviderFailure({
          ...(await errorFromResponse(res, signal, secrets)),
          upstream: 'rejected',
        });
      if (!res.body)
        throw new ProviderFailure({
          ...providerError('network', 'Response has no body'),
          upstream: 'stream',
        });

      const headerId = res.headers.get('x-generation-id')?.trim();
      let generationId: string | undefined = headerId || undefined;
      if (generationId !== undefined) yield { type: 'billing', generationId };

      let finishReason: string | null = null;
      let sawFinish = false;
      let servedBy: string | undefined;
      const citations = new Map<string, Citation>();
      let searchReported = false;
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
          throw new ProviderFailure({
            ...providerError('unknown', 'Malformed chunk from provider'),
            upstream: 'stream',
          });
        }
        if (!isRecord(chunk)) continue;

        const chunkId = chunk['id'];
        if (
          generationId === undefined &&
          typeof chunkId === 'string' &&
          chunkId.startsWith('gen-')
        ) {
          generationId = chunkId;
          yield { type: 'billing', generationId };
        }
        const upstreamProvider = chunk['provider'];
        if (
          servedBy === undefined &&
          typeof upstreamProvider === 'string' &&
          upstreamProvider.trim() !== ''
        ) {
          servedBy = upstreamProvider.trim();
          yield { type: 'billing', servedBy };
        }

        const err = chunk['error'];
        if (isRecord(err) || typeof err === 'string') {
          const errRec = isRecord(err) ? err : {};
          const message =
            typeof err === 'string'
              ? err
              : typeof errRec['message'] === 'string'
                ? errRec['message']
                : 'Provider stream error';
          yield {
            type: 'error',
            error: {
              ...providerError(codeForStreamError(errRec, message), redact(message, secrets)),
              upstream: 'stream',
            },
          };
          return;
        }

        const choices = chunk['choices'];
        const choice = Array.isArray(choices) ? (choices[0] as unknown) : undefined;
        if (isRecord(choice)) {
          const delta = choice['delta'];
          if (isRecord(delta) && typeof delta['content'] === 'string' && delta['content'] !== '') {
            yield { type: 'delta', text: delta['content'] };
          }
          if (webSearch) {
            if (!searchReported && isRecord(delta) && isWebSearchCall(delta['tool_calls'])) {
              searchReported = true;
              yield { type: 'activity', kind: 'web_search' };
            }
            const message = choice['message'];
            const fromDelta = isRecord(delta) && collectCitations(delta['annotations'], citations);
            const fromMessage =
              isRecord(message) && collectCitations(message['annotations'], citations);
            if (fromDelta || fromMessage)
              yield { type: 'citations', citations: [...citations.values()] };
          }
          const fr = choice['finish_reason'];
          if (typeof fr === 'string') {
            finishReason = fr;
            sawFinish = true;
          }
        }

        const usage = chunk['usage'];
        if (isRecord(usage)) {
          const u = usageOf(usage);
          if (Object.keys(u).length > 0) yield { type: 'usage', usage: u };
          const costUsd = num(usage['cost']);
          const stu = usage['server_tool_use'];
          const webSearches = isRecord(stu) ? num(stu['web_search_requests']) : undefined;
          if (costUsd !== undefined || webSearches !== undefined) {
            yield {
              type: 'billing',
              ...(costUsd !== undefined ? { costUsd } : {}),
              ...(webSearches !== undefined ? { webSearches } : {}),
            };
          }
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
