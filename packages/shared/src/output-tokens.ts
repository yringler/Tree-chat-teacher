/**
 * Output caps of generations (max_tokens). A reasoning model's hidden
 * thinking is billed as output and counts against the cap, so a cap sized for
 * a visible reply can end such a reply early (`stop=length`), or before it
 * says anything at all, which also loses the `<tangents>` block the apps turn
 * into branch buttons. Reasoning models therefore get a larger default cap.
 * A bigger cap costs nothing by itself (a call pays for the tokens it
 * generates); it only bounds a runaway reply.
 */

/** A reply's output cap on a model that doesn't reason. */
export const DEFAULT_REPLY_OUTPUT_TOKENS = 4096;
/** A reply's output cap on a reasoning model: room for its thinking and the answer. */
export const REASONING_REPLY_OUTPUT_TOKENS = 16_384;
/**
 * The most output a reasoning model is assumed to allow when its provider
 * config names no limit (every mainstream reasoning model allows at least
 * this: Claude Opus 4.1 32,000, DeepSeek V4 and GPT-5 far more).
 */
export const REASONING_MAX_OUTPUT_TOKENS = 32_000;
/**
 * The most output one call on the built-in provider (Learn, power's Tangent
 * credit) asks for, whatever power's setting says: with the input cap it
 * bounds the cost of any one metered call.
 */
export const BUILT_IN_MAX_OUTPUT_TOKENS = REASONING_REPLY_OUTPUT_TOKENS;
/** Output cap of a summary or a title. */
export const AUX_OUTPUT_TOKENS = 1024;
/** Output cap of a summary or a title on a reasoning model. */
export const REASONING_AUX_OUTPUT_TOKENS = 4096;

/** Smallest and largest output cap a client may ask for (`SendMessageRequest.maxOutputTokens`). */
export const MIN_REQUESTED_OUTPUT_TOKENS = 256;
export const MAX_REQUESTED_OUTPUT_TOKENS = 128_000;
/** The presets power offers; anything else in range is a custom value. */
export const OUTPUT_TOKEN_PRESETS: readonly number[] = [4096, 8192, 16_384, 32_768];

/**
 * Model ids (OpenRouter `vendor/model` or a provider's bare id) of model
 * families that think before they answer, by default or once asked to. A
 * heuristic: a provider config can set `ModelInfo.reasoning` either way.
 * Matching a model that doesn't think only gives it a larger cap.
 */
const REASONING_MODEL_PATTERNS: readonly RegExp[] = [
  /(^|\/)deepseek-(r1|reasoner|v4)/,
  // Claude 4.5 and later (`claude-sonnet-4.5`, `claude-sonnet-4-5-20250929`, `claude-opus-5-5`).
  /(^|\/)claude-(opus|sonnet|haiku|fable)-(4[.-][5-9]|[5-9])/,
  /(^|\/)o[1345](-|$)/,
  /(^|\/)gpt-(5|oss)/,
  /(^|\/)gemini-(2\.5|[3-9])/,
  /(^|\/)grok-(3-mini|[4-9])/,
  /(^|\/)(qwq|qwen3)/,
  /(^|\/)glm-(4\.[5-9]|[5-9])/,
  /(^|\/)(kimi-k2|minimax-m)/,
  /thinking|reasoner|reasoning/,
];

/** Whether `model` is (heuristically) a reasoning model; see REASONING_MODEL_PATTERNS. */
export function isReasoningModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  return REASONING_MODEL_PATTERNS.some((p) => p.test(id));
}

/** What a reply's output cap is decided from. */
export interface ReplyOutputInput {
  /** `ProviderCapabilities.reasoning`. */
  reasoning: boolean;
  /** `ProviderCapabilities.maxOutputTokens`: the model's (or provider's) limit. */
  maxOutputTokens: number;
  /** The caller's own cap (power's setting); absent or null = the default below. */
  requested?: number | null;
  /** The defaults; absent = DEFAULT_REPLY_OUTPUT_TOKENS / REASONING_REPLY_OUTPUT_TOKENS. */
  defaults?: { plain: number; reasoning: number };
}

/**
 * A reply's output cap: the requested one, else the default for the model's
 * kind (larger for reasoning models), never above the model's limit.
 */
export function replyOutputTokens(input: ReplyOutputInput): number {
  const defaults = input.defaults ?? {
    plain: DEFAULT_REPLY_OUTPUT_TOKENS,
    reasoning: REASONING_REPLY_OUTPUT_TOKENS,
  };
  const wanted = input.requested ?? (input.reasoning ? defaults.reasoning : defaults.plain);
  return Math.max(1, Math.min(Math.floor(wanted), input.maxOutputTokens));
}

/**
 * Output cap of a summary or title call on a model of `caps`: AUX_OUTPUT_TOKENS,
 * or on a reasoning model up to REASONING_AUX_OUTPUT_TOKENS within its limit.
 */
export function auxOutputTokens(caps: { reasoning?: boolean; maxOutputTokens: number }): number {
  if (!caps.reasoning) return AUX_OUTPUT_TOKENS;
  return Math.max(AUX_OUTPUT_TOKENS, Math.min(REASONING_AUX_OUTPUT_TOKENS, caps.maxOutputTokens));
}

/** `tokens` as people read it: 4096 → "4k", 16384 → "16k", 32000 → "32k", 1500 → "1.5k". */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const k = tokens % 1000 !== 0 && tokens % 1024 === 0 ? tokens / 1024 : tokens / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1).replace(/\.0$/, '')}k`;
}
