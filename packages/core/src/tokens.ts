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

const utf8 = new TextEncoder();

/** UTF-8 length of `text`, in bytes. */
export function utf8Bytes(text: string): number {
  return utf8.encode(text).length;
}

/**
 * Like `estimateTokens`, but counting UTF-8 bytes instead of characters, so a
 * budget of N "tokens" is a hard bound of 3.5·N bytes and therefore of 3.5·N
 * real tokens (byte-level BPE tokenizers never emit more tokens than bytes),
 * whatever the script. Equal to `estimateTokens` for ASCII text.
 */
export const estimateTokensUtf8: TokenEstimator = (text) =>
  text.length === 0 ? 0 : Math.ceil(utf8Bytes(text) / CHARS_PER_TOKEN);
