/**
 * Prompt (input) caching. Every turn resends the system prompt and the whole
 * ancestor path, so the stable prefix is most of a request's input; marking it
 * lets the upstream bill it at cache-read rates on the next turn.
 *
 * Two breakpoints per request (Anthropic allows four): the end of the system
 * prompt, and the end of the latest message. The latter is written on this
 * turn and read back on the next one, whose own breakpoint finds it by
 * Anthropic's lookback (the multi-turn pattern), so the conversation is cached
 * incrementally; a branch off an earlier node still reads the entry written at
 * that node's turn. A prefix under the model's minimum cacheable length is
 * silently not cached (no error, no write charge), so short prompts need no
 * special case.
 *
 * Who needs explicit markers: Anthropic's Claude models (directly, or through
 * OpenRouter as `anthropic/…`). OpenAI, DeepSeek, Grok, Moonshot, Groq and
 * Gemini 2.5+ cache automatically (Gemini implicitly, with no write charge;
 * its explicit caching would create a fresh cache object, at input price plus
 * storage, for every new last breakpoint, which costs more than it saves for
 * a growing chat), so they get no markers.
 */

/** The `cache_control` of a breakpoint: the default 5-minute TTL. */
export const CACHE_CONTROL = { type: 'ephemeral' } as const;

/**
 * Cache writes cost this multiple of the input price on models that cache with
 * explicit markers (Anthropic, 5-minute TTL); elsewhere writes cost the input
 * price (DeepSeek) or nothing extra.
 */
export const EXPLICIT_CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Whether `model` (an OpenRouter-style `vendor/model` id, optionally with
 * OpenRouter's `~` "latest" prefix) only caches with explicit `cache_control`
 * breakpoints: Anthropic's Claude models.
 */
export function usesExplicitCacheControl(model: string): boolean {
  return /^~?anthropic\//i.test(model.trim());
}

/** Whether a base URL reaches OpenRouter: openrouter.ai, or AI Gateway's OpenRouter route. */
export function isOpenRouterBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    if (url.hostname === 'openrouter.ai') return true;
    return (
      url.hostname === 'gateway.ai.cloudflare.com' &&
      url.pathname.replace(/\/+$/, '').endsWith('/openrouter')
    );
  } catch {
    return false;
  }
}

/** `options.promptCache`: true or false when set to a boolean, else undefined (automatic). */
export function promptCacheOption(
  options: Record<string, unknown> | undefined,
): boolean | undefined {
  const v = options?.['promptCache'];
  return typeof v === 'boolean' ? v : undefined;
}

/** One text content part carrying a breakpoint. */
export interface CachedTextPart {
  type: 'text';
  text: string;
  cache_control: typeof CACHE_CONTROL;
}

/**
 * `text` as a content-part array ending in a breakpoint, or `text` unchanged
 * when empty (an empty text block can't carry `cache_control`).
 */
export function withBreakpoint(text: string): string | CachedTextPart[] {
  return text === '' ? text : [{ type: 'text', text, cache_control: CACHE_CONTROL }];
}

/** `messages` with a breakpoint on the last one (a new array; the input is not modified). */
export function markLastMessage<M extends { content: string }>(
  messages: readonly M[],
): (Omit<M, 'content'> & { content: string | CachedTextPart[] })[] {
  return messages.map((m, i) =>
    i === messages.length - 1 ? { ...m, content: withBreakpoint(m.content) } : m,
  );
}

/** A plain text content part (no breakpoint). */
export interface TextPart {
  type: 'text';
  text: string;
}

/** A message as sent: plain text, or content parts (some carrying a breakpoint). */
export interface WireMessage {
  role: string;
  content: string | (CachedTextPart | TextPart)[];
}

/**
 * `messages` (already marked, or plain) with `instructions`
 * (`GenerateRequest.turnInstructions`) after the history: added to the last
 * message when it is the user's (a new user message otherwise, so roles
 * still alternate). A last message carrying a breakpoint gets them as a
 * separate text part after it, outside the cached prefix: the next turn sends
 * that message without them and still reads the entry this turn writes. A
 * plain message gets them appended to its text (automatic caches match by
 * prefix, so the tail is all they change). Blank instructions change nothing.
 */
export function withTurnInstructions(
  messages: readonly WireMessage[],
  instructions: string | undefined,
): WireMessage[] {
  const text = instructions?.trim() ?? '';
  if (text === '') return [...messages];
  const last = messages.at(-1);
  if (!last || last.role !== 'user') return [...messages, { role: 'user', content: text }];
  const content: WireMessage['content'] =
    typeof last.content === 'string'
      ? `${last.content}\n\n${text}`
      : [...last.content, { type: 'text', text }];
  return [...messages.slice(0, -1), { ...last, content }];
}
