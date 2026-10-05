// Community pool money math (docs/pool/PLAN.md §1.2), on top of the integer
// helpers in billing/pricing.ts: worst-case holds from the price table,
// token-priced costs when the provider reports none, and the margin taken at
// purchase. Exact integer (BigInt) math, rounded in the pool's favour.
import type { ChatMessage } from '@tangent/shared';
import { chargeMicros } from '../billing/pricing.js';
import type { ModelPrice } from '../config.js';

const BPS_SCALE = 10_000n;
const TOKENS_PER_PRICE_UNIT = 1_000_000n;
/** Per-message framing tokens and a constant for the request envelope (generous). */
const TOKENS_PER_MESSAGE = 4;
const TOKENS_PER_REQUEST = 16;

const encoder = new TextEncoder();

/** UTF-8 length of `text`. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

function bpsOf(bps: number): bigint {
  return BigInt(Math.max(0, Math.round(Number.isFinite(bps) ? bps : 0)));
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
 * bounds any of them, where chars/3.5 (core/tokens.ts) does not. Clamped to
 * the model's context window: a larger prompt is rejected upstream.
 */
export function inputBoundTokens(
  request: { system: string | null; messages: readonly ChatMessage[] },
  contextTokens: number,
): number {
  let bytes = request.system === null ? 0 : utf8Bytes(request.system);
  for (const m of request.messages) bytes += utf8Bytes(m.content);
  const bound = bytes + TOKENS_PER_MESSAGE * request.messages.length + TOKENS_PER_REQUEST;
  return Math.min(bound, contextTokens);
}

/** `ceil((inTok·in + outTok·out) / 10⁶ × (1 + fee))` micro-USD. */
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
 * The most a request can cost on the pool, in micro-USD: its input bound and
 * `maxOutputTokens` at the model's price, grossed up by its fee, rounded up.
 */
export function worstCaseHoldMicros(
  price: ModelPrice,
  request: { system: string | null; messages: readonly ChatMessage[] },
  maxOutputTokens: number,
  defaultFeeBps: number,
): number {
  return priceMicros(
    price,
    inputBoundTokens(request, price.contextTokens),
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

/** What a token-priced call is charged on the pool (no markup: the pool pays raw cost). */
export function chargeFromTokensMicros(
  price: ModelPrice,
  inputTokens: number | null,
  outputTokens: number | null,
  feeBps: number,
): number {
  return chargeMicros(costFromTokensNanos(price, inputTokens, outputTokens), 0, feeBps);
}

/**
 * Pool credit bought with `grossMicros` (pre-tax) at `marginBps`:
 * `floor(gross × 10⁴ / (10⁴ + margin))`, so $10 at 8% buys $9.259259.
 */
export function poolCreditMicros(grossMicros: number, marginBps: number): number {
  if (!Number.isFinite(grossMicros) || grossMicros <= 0) return 0;
  const gross = BigInt(Math.floor(grossMicros));
  return Number((gross * BPS_SCALE) / (BPS_SCALE + bpsOf(marginBps)));
}

/**
 * The pool credit a refund of `refundGrossMicros` (pre-tax) of a pool
 * purchase takes back: the same share of the credit the purchase granted,
 * `round(refund × credit / gross)`, so refunding $10 bought at 8% takes
 * $9.259259 of pool credit, not $10.
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
