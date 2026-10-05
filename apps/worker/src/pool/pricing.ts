// Community pool money math (docs/pool/PLAN.md §1.2), on top of the integer
// helpers in billing/pricing.ts: worst-case holds from the price table,
// token-priced costs when the provider reports none, and refund shares of a
// purchase. Every charge is the call's true cost, price × (1 + fee), with no
// markup (Tangent funds the pool, so a markup on it would be meaningless;
// rows reserved before carry their stored markup), and every hold is priced
// the same way, so a hold always covers its charge. Exact integer (BigInt)
// math, rounded in the pool's favour.
import type { ChatMessage } from '@tangent/shared';
import { BPS_SCALE, bpsOf, chargeMicros } from '../billing/pricing.js';
import type { ModelPrice } from '../config.js';

const TOKENS_PER_PRICE_UNIT = 1_000_000n;
/** Per-message framing tokens and a constant for the request envelope (generous). */
const TOKENS_PER_MESSAGE = 4;
const TOKENS_PER_REQUEST = 16;

const encoder = new TextEncoder();

/** UTF-8 length of `text`. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

function tokensOf(n: number | null | undefined): bigint {
  return BigInt(Math.max(0, Math.ceil(Number.isFinite(n ?? NaN) ? (n as number) : 0)));
}

/** The price entry's fee, else the deployment's OpenRouter fee. */
export function feeBpsOf(price: ModelPrice, defaultFeeBps: number): number {
  return price.feeBps ?? defaultFeeBps;
}

/**
 * An upper bound on the input tokens of a request: byte-level BPE tokenizers
 * never emit more tokens than input bytes, so the UTF-8 length (plus framing)
 * bounds any of them, where chars/3.5 (core/tokens.ts) does not.
 */
export function inputBoundTokens(request: {
  system: string | null;
  messages: readonly ChatMessage[];
}): number {
  let bytes = request.system === null ? 0 : utf8Bytes(request.system);
  for (const m of request.messages) bytes += utf8Bytes(m.content);
  return bytes + TOKENS_PER_MESSAGE * request.messages.length + TOKENS_PER_REQUEST;
}

/**
 * Whether a request's input bound exceeds the price entry's context window.
 * The pool refuses such a request instead of clamping its hold, so a hold is
 * a true bound even when `contextTokens` is below the model's real window.
 */
export function exceedsContext(
  price: ModelPrice,
  request: { system: string | null; messages: readonly ChatMessage[] },
): boolean {
  return inputBoundTokens(request) > price.contextTokens;
}

/** `ceil((inTok·in + outTok·out) / 10⁶ × (1 + fee))` micro-USD: the true cost, no markup. */
function priceMicros(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
  feeBps: number,
): number {
  const raw =
    tokensOf(inputTokens) * BigInt(price.inMicrosPerMTok) +
    tokensOf(outputTokens) * BigInt(price.outMicrosPerMTok);
  const divisor = TOKENS_PER_PRICE_UNIT * BPS_SCALE;
  return Number((raw * (BPS_SCALE + bpsOf(feeBps)) + divisor - 1n) / divisor);
}

/**
 * The most a request can cost on the pool, in micro-USD: its input bound
 * (at most the context window; see `exceedsContext`) and `maxOutputTokens` at
 * the model's price, grossed up by its fee, rounded up.
 */
export function worstCaseHoldMicros(
  price: ModelPrice,
  request: { system: string | null; messages: readonly ChatMessage[] },
  maxOutputTokens: number,
  defaultFeeBps: number,
): number {
  return priceMicros(
    price,
    Math.min(inputBoundTokens(request), price.contextTokens),
    maxOutputTokens,
    feeBpsOf(price, defaultFeeBps),
  );
}

/**
 * The reply's hold before its prompt is assembled: a full context window in,
 * `maxOutputTokens` out. Never below the worst case of any request on the
 * same model and output cap.
 */
export function ceilingHoldMicros(
  price: ModelPrice,
  maxOutputTokens: number,
  defaultFeeBps: number,
): number {
  return priceMicros(price, price.contextTokens, maxOutputTokens, feeBpsOf(price, defaultFeeBps));
}

/** The model price of `inputTokens` in and `outputTokens` out, in nano-USD (rounded up), before fees. */
export function costFromTokensNanos(
  price: ModelPrice,
  inputTokens: number | null,
  outputTokens: number | null,
): number {
  // µ$/MTok × tokens / 10⁶ = µ$; × 1000 = n$.
  const raw =
    tokensOf(inputTokens) * BigInt(price.inMicrosPerMTok) +
    tokensOf(outputTokens) * BigInt(price.outMicrosPerMTok);
  return Number((raw + 999n) / 1000n);
}

/** What a token-priced call is charged on the pool: its true cost, plus the row's stored markup (0 since the pool went at-cost). */
export function chargeFromTokensMicros(
  price: ModelPrice,
  inputTokens: number | null,
  outputTokens: number | null,
  feeBps: number,
  markupBps: number,
): number {
  return chargeMicros(costFromTokensNanos(price, inputTokens, outputTokens), markupBps, feeBps);
}

/**
 * The pool credit a refund of `refundGrossMicros` (pre-tax) of a pool
 * purchase takes back: the same share of the credit the purchase granted,
 * `round(refund × credit / gross)`, so refunding all of a $10 purchase that
 * added $9.20 (net of the processing fee) takes $9.20 of pool credit, and
 * refunding half of it $4.60. Also the proportion of a membership payment's
 * pool share a refund takes back (`reverseMembershipShare`).
 */
export function creditEquivalentMicros(
  refundGrossMicros: number,
  grant: { amountMicros: number; grossMicros: number },
): number {
  if (refundGrossMicros <= 0 || grant.grossMicros <= 0 || grant.amountMicros <= 0) return 0;
  const num = BigInt(Math.round(refundGrossMicros)) * BigInt(Math.round(grant.amountMicros));
  const den = BigInt(Math.round(grant.grossMicros));
  return Number((2n * num + den) / (2n * den));
}
