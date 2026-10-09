import type {
  Citation,
  GenerateRequest,
  LlmProvider,
  ModelInfo,
  ProviderConfig,
  ProviderErrorCode,
  ProviderEvent,
} from '@tangent/shared';
import type { ProviderEnv } from './registry.js';
import {
  guardStream,
  isRecord,
  providerError,
  resolveCapabilities,
  sleep,
  abortError,
} from './internal.js';

const DEFAULTS = { maxContextTokens: 200_000, maxOutputTokens: 4096, supportsSystemPrompt: true };
const DEFAULT_MODELS: ModelInfo[] = [{ id: 'fake-1', label: 'Fake 1' }];
const ERROR_CODES: ReadonlySet<string> = new Set<ProviderErrorCode>([
  'auth',
  'rate_limit',
  'overloaded',
  'invalid_request',
  'context_length',
  'aborted',
  'network',
  'server',
  'config',
  'unknown',
]);

interface FakeOptions {
  responses: [string, string][];
  stopReasons: [string, string][];
  chunkSize: number;
  delayMs: number;
  failWith: ProviderErrorCode | null;
  costUsd: number | null;
  citations: Citation[];
  webSearchCostUsd: number;
  echoRequest: boolean | string;
}

function readResponses(r: unknown): [string, string][] {
  const out: [string, string][] = [];
  if (isRecord(r)) {
    for (const [k, v] of Object.entries(r)) if (typeof v === 'string') out.push([k, v]);
  }
  return out;
}

function readOptions(options: Record<string, unknown> | undefined): FakeOptions {
  const o = options ?? {};
  const cs = o['chunkSize'];
  const dm = o['delayMs'];
  const fw = o['failWith'];
  const cost = o['costUsd'];
  const wsCost = o['webSearchCostUsd'];
  const citations: Citation[] = [];
  const rawCitations = o['citations'];
  if (Array.isArray(rawCitations)) {
    for (const c of rawCitations) {
      if (!isRecord(c) || typeof c['url'] !== 'string') continue;
      citations.push({
        url: c['url'],
        title: typeof c['title'] === 'string' ? c['title'] : null,
        excerpt: typeof c['excerpt'] === 'string' ? c['excerpt'] : null,
      });
    }
  }
  const echo = o['echoRequest'];
  return {
    responses: readResponses(o['responses']),
    stopReasons: readResponses(o['stopReasons']),
    chunkSize: typeof cs === 'number' && Number.isInteger(cs) && cs > 0 ? cs : 8,
    delayMs: typeof dm === 'number' && dm > 0 ? dm : 0,
    failWith: typeof fw === 'string' && ERROR_CODES.has(fw) ? (fw as ProviderErrorCode) : null,
    costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    citations,
    webSearchCostUsd:
      typeof wsCost === 'number' && Number.isFinite(wsCost) && wsCost >= 0 ? wsCost : 0,
    echoRequest: echo === true || (typeof echo === 'string' && echo !== '') ? echo : false,
  };
}

type Input = Pick<GenerateRequest, 'model' | 'system' | 'messages' | 'maxOutputTokens'>;

function inputTokens(request: Input): number {
  let chars = request.system?.length ?? 0;
  for (const m of request.messages) chars += m.content.length;
  return Math.ceil(chars / 4);
}

/**
 * Deterministic provider for tests (worker tests configure it through
 * `PROVIDERS` / `BUILT_IN_PROVIDER`). It is a test seam, not a feature: it is
 * never among the default providers, so no user is offered it.
 *
 * Reply text, unless overridden:
 *   `Fake reply (${model}) to ${messages.length} message(s): "${lastUser.slice(0, 80)}"`
 * where lastUser is the content of the last user message.
 *
 * options (all optional):
 * - responses: Record<string, string> — if the last user message contains a
 *   key, reply with its value (first match in insertion order);
 * - stopReasons: Record<string, string> — if the last user message contains a
 *   key, end with its value as `done.stopReason` (e.g. `length`: a reply cut
 *   off at its cap) instead of `end_turn`;
 * - chunkSize: number (default 8) — characters per `delta`;
 * - delayMs: number (default 0) — await between deltas (to test abort);
 * - failWith: ProviderErrorCode — emit this error after the first delta;
 * - echoRequest: true | string (tests only) — reply with what the request
 *   asked for instead: `ECHO model=<model> maxOutputTokens=<n> system=<JSON
 *   of the system prompt>`; a string echoes only when the last user message
 *   contains it (so one config can serve other tests unchanged);
 * - costUsd: number — simulate OpenRouter billing: yield
 *   `{type:'billing', generationId:'gen-fake-<uuid>'}` before the first delta and
 *   `{type:'billing', generationId, costUsd}` right before `done` (not on
 *   failure or abort). Every stream gets a fresh id;
 * - webSearch: boolean — capability `supportsWebSearch`. When a request
 *   carries `webSearch` (and the option is on), the fake "searches" if the
 *   mode is `required` or `citations` is non-empty: it yields
 *   `{type:'activity'}` before the first delta, `{type:'citations'}` (the
 *   scripted `citations`, possibly empty) after the last, and adds
 *   `webSearchCostUsd` (default 0) to `costUsd` with `webSearches: 1`;
 * - citations: {url, title?, excerpt?}[] — scripted sources;
 * - maxContextTokens / maxOutputTokens via config.
 * Usage: inputTokens = ceil(total input chars / 4), outputTokens = ceil(reply chars / 4),
 * emitted once before `done`. countTokens returns the same inputTokens figure.
 */
export function createFakeProvider(config: ProviderConfig, env: ProviderEnv): LlmProvider {
  void env;
  const opts = readOptions(config.options);
  const models = config.models.length > 0 ? config.models : DEFAULT_MODELS;
  const defaultModel = config.defaultModel || (models[0]?.id ?? 'fake-1');
  const effectiveConfig: ProviderConfig = { ...config, models };

  const lastUserOf = (request: Input): string => {
    for (let i = request.messages.length - 1; i >= 0; i--) {
      const m = request.messages[i];
      if (m?.role === 'user') return m.content;
    }
    return '';
  };

  const replyFor = (request: Input): string => {
    const lastUser = lastUserOf(request);
    const echo = opts.echoRequest;
    if (echo === true || (typeof echo === 'string' && lastUser.includes(echo))) {
      return `ECHO model=${request.model} maxOutputTokens=${request.maxOutputTokens ?? 'none'} system=${JSON.stringify(request.system)}`;
    }
    for (const [key, value] of opts.responses) if (lastUser.includes(key)) return value;
    return `Fake reply (${request.model}) to ${request.messages.length} message(s): "${lastUser.slice(0, 80)}"`;
  };

  function stream(request: GenerateRequest): AsyncIterable<ProviderEvent> {
    return guardStream(request.signal, [], async function* () {
      // Unique across provider instances, isolates and restarts (usage_events.generation_id is UNIQUE).
      const generationId = opts.costUsd === null ? null : `gen-fake-${crypto.randomUUID()}`;
      if (generationId !== null) yield { type: 'billing', generationId };
      const searches =
        request.webSearch !== undefined &&
        config.options?.['webSearch'] === true &&
        (request.webSearch.mode === 'required' || opts.citations.length > 0);
      if (searches) yield { type: 'activity', kind: 'web_search' };
      const reply = replyFor(request);
      const chars = Array.from(reply);
      let first = true;
      for (let i = 0; i < chars.length; i += opts.chunkSize) {
        if (opts.delayMs > 0) await sleep(opts.delayMs, request.signal);
        if (request.signal.aborted) throw abortError();
        yield { type: 'delta', text: chars.slice(i, i + opts.chunkSize).join('') };
        if (first && opts.failWith) {
          yield {
            type: 'error',
            error: providerError(opts.failWith, `Fake failure: ${opts.failWith}`),
          };
          return;
        }
        first = false;
      }
      if (opts.failWith) {
        // Empty reply: still fail as configured.
        yield {
          type: 'error',
          error: providerError(opts.failWith, `Fake failure: ${opts.failWith}`),
        };
        return;
      }
      yield {
        type: 'usage',
        usage: { inputTokens: inputTokens(request), outputTokens: Math.ceil(reply.length / 4) },
      };
      if (searches) yield { type: 'citations', citations: opts.citations.map((c) => ({ ...c })) };
      if (generationId !== null && opts.costUsd !== null) {
        yield {
          type: 'billing',
          generationId,
          costUsd: opts.costUsd + (searches ? opts.webSearchCostUsd : 0),
          ...(searches ? { webSearches: 1 } : {}),
        };
      }
      const lastUser = lastUserOf(request);
      const stopReason =
        opts.stopReasons.find(([key]) => lastUser.includes(key))?.[1] ?? 'end_turn';
      yield { type: 'done', stopReason };
    });
  }

  return {
    id: config.id,
    kind: 'fake',
    label: config.label,
    models: () => models.map((m) => ({ ...m })),
    defaultModel: () => defaultModel,
    capabilities: (model: string) => resolveCapabilities(effectiveConfig, model, DEFAULTS, true),
    stream,
    countTokens: async (request) => {
      if (request.signal?.aborted) throw abortError();
      return inputTokens(request);
    },
  };
}
