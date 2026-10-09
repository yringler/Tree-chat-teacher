import type {
  Citation,
  GenerateRequest,
  LlmProvider,
  ProviderEvent,
  ProviderInfo,
  ProviderRegistry,
  StreamEvent,
} from '@tangent/shared';
import {
  ChatService,
  DEFAULT_CHAT_SETTINGS,
  type ChatServiceDeps,
  type ChatSettings,
  type RunGenerationOptions,
} from '../../src/services/chat-service.js';
import { ShareService } from '../../src/services/share-service.js';
import { createMemoryRepositories } from '../../src/testing/memory-repositories.js';

/**
 * Scripted provider: replies depend on the request so tests can tell
 * summary / title / chat calls apart. Records every request.
 */
export class ScriptedProvider implements LlmProvider {
  readonly kind = 'openai-compatible' as const;
  readonly label = 'Scripted';
  readonly calls: GenerateRequest[] = [];
  failNext: string | null = null;
  delayMs = 0;
  contextTokens = 200_000;
  /** Capability `supportsWebSearch`. */
  webSearch = false;
  /** Sources a search "finds"; it searches when offered and this is non-empty, or when required. */
  citations: Citation[] = [];
  /** Reject a request carrying `webSearch` with invalid_request (before any delta). */
  rejectSearch = false;
  /** Capabilities `maxOutputTokens` and `reasoning`. */
  maxOutputTokens = 1000;
  reasoning = false;
  /** `done.stopReason` of chat replies (`length`: cut off at the cap). */
  chatStopReason = 'end_turn';
  /** Text of chat replies instead of the default echo (`''`: an empty reply). */
  chatText: string | null = null;
  /** Set by a test that counts tokens (with capability `supportsTokenCount`). */
  countTokens?: LlmProvider['countTokens'];

  constructor(readonly id = 'scripted') {}

  models() {
    return [{ id: 'm1', label: 'M1' }];
  }
  defaultModel() {
    return 'm1';
  }
  capabilities() {
    return {
      maxContextTokens: this.contextTokens,
      maxOutputTokens: this.maxOutputTokens,
      supportsSystemPrompt: true,
      supportsTokenCount: false,
      supportsWebSearch: this.webSearch,
      requiredWebSearch: this.webSearch,
      reasoning: this.reasoning,
    };
  }

  kindOf(req: GenerateRequest): 'title' | 'summary' | 'chat' {
    const sys = (req.system ?? '').toLowerCase();
    if (sys.startsWith('you write faithful, concise summaries')) return 'summary';
    if (sys.includes('title') && !sys.includes('## ')) return 'title';
    return 'chat';
  }

  async *stream(req: GenerateRequest): AsyncIterable<ProviderEvent> {
    this.calls.push(req);
    const kind = this.kindOf(req);
    const last = req.messages.at(-1)?.content ?? '';
    const text =
      kind === 'title'
        ? 'Scripted Title'
        : kind === 'summary'
          ? `SUMMARY(${req.messages.length})`
          : (this.chatText ?? `reply to: ${last.slice(0, 40)}`);
    const searches =
      req.webSearch !== undefined &&
      (req.webSearch.mode === 'required' || this.citations.length > 0);
    if (req.webSearch !== undefined && this.rejectSearch) {
      yield {
        type: 'error',
        error: { code: 'invalid_request', message: 'tools unsupported', retryable: false },
      };
      return;
    }
    yield { type: 'usage', usage: { inputTokens: 10 } };
    if (searches) yield { type: 'activity', kind: 'web_search' };
    for (let i = 0; i < text.length; i += 5) {
      if (req.signal.aborted) {
        yield { type: 'error', error: { code: 'aborted', message: 'aborted', retryable: false } };
        return;
      }
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      yield { type: 'delta', text: text.slice(i, i + 5) };
      if (this.failNext && kind === 'chat') {
        const message = this.failNext;
        this.failNext = null;
        yield { type: 'error', error: { code: 'server', message, retryable: true } };
        return;
      }
    }
    yield { type: 'usage', usage: { outputTokens: 3 } };
    if (searches) {
      yield { type: 'citations', citations: this.citations };
      yield { type: 'billing', costUsd: 0.008, webSearches: 1 };
    }
    yield { type: 'done', stopReason: kind === 'chat' ? this.chatStopReason : 'end_turn' };
  }

  chatCalls(): GenerateRequest[] {
    return this.calls.filter((c) => this.kindOf(c) === 'chat');
  }
  summaryCalls(): GenerateRequest[] {
    return this.calls.filter((c) => this.kindOf(c) === 'summary');
  }
}

export function registryOf(...providers: LlmProvider[]): ProviderRegistry {
  return {
    get: (id) => providers.find((p) => p.id === id),
    list: (): ProviderInfo[] =>
      providers.map((p) => ({
        id: p.id,
        kind: p.kind,
        label: p.label,
        models: p.models(),
        defaultModel: p.defaultModel(),
        openModels: false,
        available: true,
        acceptsUserKey: p.kind !== 'fake',
        keySource: null,
      })),
    defaultProviderId: () => providers[0]!.id,
  };
}

export function setup(
  settings: Partial<ChatSettings> = {},
  deps: Pick<ChatServiceDeps, 'groundingAllowance' | 'log'> = {},
) {
  const repos = createMemoryRepositories();
  const provider = new ScriptedProvider();
  let t = Date.parse('2026-01-01T00:00:00Z');
  const clock = () => new Date((t += 1000));
  let n = 0;
  const newId = () => `id${(++n).toString().padStart(4, '0')}`;
  const chat = new ChatService({
    repos,
    providers: registryOf(provider),
    settings: { ...DEFAULT_CHAT_SETTINGS, ...settings },
    clock,
    newId,
    ...deps,
  });
  let tok = 0;
  const shares = new ShareService({
    repos,
    publicBaseUrl: 'https://tangent.test/',
    clock,
    newId,
    newToken: () => `token${++tok}`,
  });
  return {
    repos,
    provider,
    chat,
    shares,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** Sends a message and runs the generation to completion. */
export async function send(
  chat: ChatService,
  branchId: string,
  content: string,
  options: RunGenerationOptions = {},
) {
  const begin = await chat.beginSend(branchId, content);
  const events = await collect(chat.runGeneration(begin, new AbortController().signal, options));
  return { begin, events, last: events.at(-1)! };
}
