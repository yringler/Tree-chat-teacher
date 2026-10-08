/**
 * One streamed OpenRouter chat completion with usage accounting
 * (`usage: {include: true}`): answer, finish reason, the provider that served
 * it, token counts (cached, reasoning) and the billed cost. Reasoning text is
 * never kept: only the answer and the reasoning token count are recorded.
 */
import type { CallUsage, EvalConfig } from './types.ts';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** A message as sent: plain text, or text parts carrying a cache breakpoint. */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[];
}

export interface StreamOutcome {
  provider: string | null;
  finishReason: string | null;
  answer: string;
  usage: CallUsage | null;
  firstAnswerMs: number | null;
  generationId: string | null;
}

export function requestBody(config: EvalConfig, messages: WireMessage[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    stream: true,
    usage: { include: true },
  };
  if (config.effort === 'off') body['reasoning'] = { enabled: false };
  else if (config.effort !== null) body['reasoning'] = { effort: config.effort };
  if (config.providerOrder && config.providerOrder.length > 0)
    body['provider'] = {
      order: config.providerOrder,
      allow_fallbacks: config.allowFallbacks ?? true,
    };
  return { ...body, ...config.extraBody };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function parseUsage(u: unknown): CallUsage | null {
  if (!isRecord(u)) return null;
  const prompt = isRecord(u['prompt_tokens_details']) ? u['prompt_tokens_details'] : {};
  const completion = isRecord(u['completion_tokens_details']) ? u['completion_tokens_details'] : {};
  return {
    promptTokens: num(u['prompt_tokens']),
    cachedTokens: num(prompt['cached_tokens']),
    cacheWriteTokens: num(prompt['cache_write_tokens']),
    completionTokens: num(u['completion_tokens']),
    reasoningTokens: num(completion['reasoning_tokens']),
    cost: num(u['cost']),
  };
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Streams one completion; throws HttpError on a non-2xx response or an in-stream error. */
export async function streamCompletion(
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<StreamOutcome> {
  const t0 = Date.now();
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-title': 'Tangent model eval',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status, text.slice(0, 600));
  }
  const out: StreamOutcome = {
    provider: null,
    finishReason: null,
    answer: '',
    usage: null,
    firstAnswerMs: null,
    generationId: res.headers.get('x-generation-id'),
  };
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (data: string): void => {
    if (data === '[DONE]') return;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(chunk)) return;
    if (isRecord(chunk['error'])) {
      const e = chunk['error'];
      throw new HttpError(num(e['code']) || 500, String(e['message'] ?? 'stream error'));
    }
    if (typeof chunk['provider'] === 'string') out.provider = chunk['provider'];
    if (typeof chunk['id'] === 'string' && out.generationId === null)
      out.generationId = chunk['id'];
    const choices = Array.isArray(chunk['choices']) ? chunk['choices'] : [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice['delta']) ? choice['delta'] : {};
      if (typeof delta['content'] === 'string' && delta['content'] !== '') {
        out.firstAnswerMs ??= Date.now() - t0;
        out.answer += delta['content'];
      }
      if (typeof choice['finish_reason'] === 'string') out.finishReason = choice['finish_reason'];
    }
    const usage = parseUsage(chunk['usage']);
    if (usage) out.usage = usage;
  };
  for await (const part of res.body) {
    buffer += decoder.decode(part as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) handle(line.slice(5).trim());
    }
  }
  if (buffer.trim().startsWith('data:')) handle(buffer.trim().slice(5).trim());
  return out;
}
