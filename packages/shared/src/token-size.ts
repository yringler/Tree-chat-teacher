/*
 * Token counts as people picture them: words, paperback pages, a kind of book,
 * and what sending that many input tokens costs. Shared by the apps (power's
 * input limit setting) and the Worker's server-rendered pages, so both say the
 * same. Rough by design: English prose, display only.
 */

/** About how many English words one token is (OpenAI's and Anthropic's rule of thumb). */
export const WORDS_PER_TOKEN = 0.75;
/** Words on a page of a standard paperback (a 5×8 in trade paperback runs 250–300). */
export const WORDS_PER_PAGE = 275;
/** An average novel's length in words, for counts of several novels. */
const WORDS_PER_NOVEL = 90_000;

/** About how many English words `tokens` tokens make. */
export function tokensToWords(tokens: number): number {
  return tokens * WORDS_PER_TOKEN;
}

/** About how many paperback pages `tokens` tokens fill. */
export function tokensToPages(tokens: number): number {
  return tokensToWords(tokens) / WORDS_PER_PAGE;
}

/** About how many English words `tokens` tokens make (¾ of a word each), to the nearest 50: `750` for 1,024. */
export function roughWords(tokens: number): string {
  return Math.max(50, Math.round(tokensToWords(tokens) / 50) * 50).toLocaleString('en-US');
}

/**
 * `n` to two significant figures, as people read an estimate: 45,000;
 * 160; 2.7. Never below `min` (an estimate of nothing reads as a mistake).
 */
export function roundEstimate(n: number, min = 0): number {
  if (!Number.isFinite(n) || n <= 0) return min;
  const step = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.max(min, Number((Math.round(n / step) * step).toPrecision(2)));
}

/**
 * What a text of `words` words is about as long as, on the fiction length
 * scale (SFWA's: a short story under 7,500 words, a novelette under 17,500,
 * a novella under 40,000, a novel beyond), with an essay below and several
 * novels above.
 */
export function lengthComparison(words: number): string {
  if (words < 1500) return 'a short essay';
  if (words < 7500) return 'a short story';
  if (words < 17_500) return 'a novelette';
  if (words < 40_000) return 'a novella';
  if (words < 70_000) return 'a short novel';
  if (words < 120_000) return 'a novel';
  if (words < 200_000) return 'a long novel';
  return `${Math.round(words / WORDS_PER_NOVEL)} novels`;
}

/** `tokens` in words, pages and a comparison, each rounded for reading. */
export interface TokenSize {
  words: number;
  pages: number;
  /** "a short novel", "8 novels": see `lengthComparison`. */
  like: string;
}

export function tokenSize(tokens: number): TokenSize {
  const words = tokensToWords(tokens);
  return {
    words: roundEstimate(words, 1),
    pages: roundEstimate(tokensToPages(tokens), 1),
    like: lengthComparison(words),
  };
}

/**
 * `tokens` as one sentence: "60,000 tokens ≈ 45,000 words ≈ 160 paperback
 * pages, about the length of a short novel."
 */
export function describeTokenSize(tokens: number): string {
  const { words, pages, like } = tokenSize(tokens);
  return (
    `${tokens.toLocaleString('en-US')} tokens ≈ ${words.toLocaleString('en-US')} words ≈ ` +
    `${pages.toLocaleString('en-US')} paperback ${pages === 1 ? 'page' : 'pages'}, ` +
    `about the length of ${like}.`
  );
}

/** What `tokens` input tokens cost at `usdPerMTok` (USD per million tokens). */
export function inputCostUsd(tokens: number, usdPerMTok: number): number {
  return (tokens * usdPerMTok) / 1_000_000;
}

/**
 * A small amount of US dollars as an estimate: cents from 10¢ up (`$0.12`,
 * `$3.40`), else two significant figures (`$0.012`, `$0.0012`), `$0` for nothing.
 */
export function formatUsdEstimate(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  const rough = Number(usd.toPrecision(2));
  if (rough >= 0.1) {
    return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `$${rough.toFixed(1 - Math.floor(Math.log10(rough)))}`;
}
