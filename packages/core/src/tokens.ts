/**
 * Token estimation without a tokenizer. Conservative (~3.5 chars/token) so
 * budgets err on the safe side for code, CJK text and newer tokenizers.
 * Exact counts come from provider usage after the fact, or `countTokens`.
 */
export type TokenEstimator = (text: string) => number;

export const CHARS_PER_TOKEN = 3.5;
/** Per-message framing overhead (role markers etc.). */
export const MESSAGE_OVERHEAD_TOKENS = 4;

export const estimateTokens: TokenEstimator = (text) =>
  text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
