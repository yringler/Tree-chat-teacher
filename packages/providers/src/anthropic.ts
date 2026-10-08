import {
  CITATION_EXCERPT_MAX,
  CITATIONS_MAX,
  isCitableUrl,
  type Citation,
  type GenerateRequest,
  type LlmProvider,
  type ProviderConfig,
  type ProviderErrorCode,
  type ProviderEvent,
  type ProviderUsage,
  type WebSearchRequest,
} from '@tangent/shared';
import { markLastMessage, promptCacheOption, withBreakpoint, withTurnInstructions } from './prompt-cache.js';
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

/**
 * Anthropic's web search server tool, at most `maxUses` searches. The basic
 * `web_search_20250305` runs on every Claude model and platform; the
 * `_20260209` variant's dynamic filtering runs code over the results, which
 * one search per reply doesn't need. `tool_choice` stays `auto` even when a
 * search is required ("Check sources"): current models reject a forced tool
 * choice, and CHECK_SOURCES_INSTRUCTIONS asks for the search.
 */
function webSearchTool(ws: WebSearchRequest): Record<string, unknown> {
  return { type: 'web_search_20250305', name: 'web_search', max_uses: ws.maxUses };
}

/**
 * Adds a streamed `web_search_result_location` citation to `into`
 * (deduplicated by URL, http(s) only, excerpt clipped). Returns true if added.
 */
function collectCitation(raw: unknown, into: Map<string, Citation>): boolean {
  if (!isRecord(raw) || raw['type'] !== 'web_search_result_location') return false;
  if (typeof raw['url'] !== 'string') return false;
  const url = raw['url'].trim();
  if (!isCitableUrl(url) || into.has(url) || into.size >= CITATIONS_MAX) return false;
  const title =
    typeof raw['title'] === 'string' && raw['title'].trim() ? raw['title'].trim().slice(0, 500) : null;
  const text = typeof raw['cited_text'] === 'string' ? raw['cited_text'].replace(/\s+/g, ' ').trim() : '';
  const excerpt = text
    ? text.length > CITATION_EXCERPT_MAX
      ? `${text.slice(0, CITATION_EXCERPT_MAX - 1)}…`
      : text
    : null;
  into.set(url, { url, title, excerpt });
  return true;
}

/** Total input tokens (uncached + cache writes + cache reads), if reported. */
function inputTokensOf(usage: Record<string, unknown>): number | undefined {
  const base = num(usage['input_tokens']);
  if (base === undefined) return undefined;
  return base + (num(usage['cache_creation_input_tokens']) ?? 0) + (num(usage['cache_read_input_tokens']) ?? 0);
}

/** A `usage` object as our usage fields (only those reported). */
function usageOf(usage: Record<string, unknown>): Partial<ProviderUsage> {
  const u: Partial<ProviderUsage> = {};
  const input = inputTokensOf(usage);
  if (input !== undefined) u.inputTokens = input;
  const output = num(usage['output_tokens']);
  if (output !== undefined) u.outputTokens = output;
  const read = num(usage['cache_read_input_tokens']);
  if (read !== undefined) u.cacheReadTokens = read;
  const write = num(usage['cache_creation_input_tokens']);
  if (write !== undefined) u.cacheWriteTokens = write;
  return u;
}

/**
 * Anthropic Messages API over raw fetch + SSE (POST {baseUrl}/v1/messages,
 * `anthropic-version: 2023-06-01`). Default baseUrl https://api.anthropic.com;
 * set baseUrl to an AI Gateway URL (…/{account}/{gateway}/anthropic) to route
 * through Cloudflare AI Gateway. Implements countTokens via
 * /v1/messages/count_tokens. Does not send `temperature` or assistant prefill.
 *
 * Prompt caching (prompt-cache.ts): `cache_control` breakpoints on the system
 * prompt and on the latest message, unless `options.promptCache` is false
 * (e.g. a proxy that rejects them). `request.turnInstructions` follow the
 * latest message as a separate text part after its breakpoint
 * (`withTurnInstructions`). Usage reports the input total
 * (uncached + cache writes + cache reads) and the cache reads and writes.
 *
 * Web search (when `options.webSearch` is true and the request has
 * `webSearch`): sends Anthropic's `web_search` server tool, reports the
 * search starting (`server_tool_use`) as `activity`, the cited results
 * (`citations_delta`) as `citations`, and
 * `usage.server_tool_use.web_search_requests` as `billing.webSearches`.
 * Anthropic reports no cost, so the search fee (about $0.01) is not in any
 * `billing.costUsd`: enable it on own-key configs, not a metered one.
 */
export function createAnthropicProvider(config: ProviderConfig, env: ProviderEnv): LlmProvider {
  const baseUrl = stripTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
  const doFetch = getFetch(env);

  const capabilities = (model: string) => resolveCapabilities(config, model, DEFAULTS, true);

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
  const promptCache = promptCacheOption(config.options) !== false;

  function stream(request: GenerateRequest): AsyncIterable<ProviderEvent> {
    const built = buildHeaders();
    const secrets = 'secrets' in built ? built.secrets : [];
    return guardStream(request.signal, secrets, async function* () {
      if ('missing' in built) throw new ProviderFailure(missingSecretError(built.missing));
      const { signal } = request;
      const caps = capabilities(request.model);
      const body: Record<string, unknown> = {
        model: request.model,
        max_tokens: request.maxOutputTokens ?? caps.maxOutputTokens,
      };
      if (request.system !== null)
        body['system'] = promptCache ? withBreakpoint(request.system) : request.system;
      body['messages'] = withTurnInstructions(
        promptCache ? markLastMessage(messagesOf(request)) : messagesOf(request),
        request.turnInstructions,
      );
      const webSearch = request.webSearch && caps.supportsWebSearch ? request.webSearch : null;
      if (webSearch) body['tools'] = [webSearchTool(webSearch)];
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
      const citations = new Map<string, Citation>();
      let searchReported = false;
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
              const u = usageOf(usage);
              if (Object.keys(u).length > 0) yield { type: 'usage', usage: u };
            }
            break;
          }
          case 'content_block_start': {
            const block = data['content_block'];
            if (
              webSearch &&
              !searchReported &&
              isRecord(block) &&
              block['type'] === 'server_tool_use' &&
              block['name'] === 'web_search'
            ) {
              searchReported = true;
              yield { type: 'activity', kind: 'web_search' };
            }
            break;
          }
          case 'content_block_delta': {
            const delta = data['delta'];
            if (isRecord(delta) && delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
              if (delta['text'] !== '') yield { type: 'delta', text: delta['text'] };
            } else if (webSearch && isRecord(delta) && delta['type'] === 'citations_delta') {
              if (collectCitation(delta['citation'], citations)) {
                yield { type: 'citations', citations: [...citations.values()] };
              }
            }
            break;
          }
          case 'message_delta': {
            const delta = data['delta'];
            if (isRecord(delta) && typeof delta['stop_reason'] === 'string') stopReason = delta['stop_reason'];
            const usage = data['usage'];
            if (isRecord(usage)) {
              const u = usageOf(usage);
              if (Object.keys(u).length > 0) yield { type: 'usage', usage: u };
              const stu = usage['server_tool_use'];
              const webSearches = isRecord(stu) ? num(stu['web_search_requests']) : undefined;
              if (webSearches !== undefined) yield { type: 'billing', webSearches };
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
            // ping, content_block_stop and unknown events.
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
