// Open pool money math, on top of the integer
// helpers in @tangent/shared's charge.ts: worst-case holds from the price table, and
// token-priced costs when the provider reports none. Every pool charge is the
// call's true cost, price × (1 + fee), with no markup (Tangent funds the
// pool, so a markup on it would be meaningless), and every hold is priced the
// same way, so a hold always covers its charge. Exact integer (BigInt) math,
// rounded in the pool's favour.
import { CHARS_PER_TOKEN, renderOverheadBytes, utf8Bytes } from '@tangent/core';
import { chargeMicros, type ChatMessage } from '@tangent/shared';
import type { ModelPrice } from '../config.js';

/** Per-message framing tokens and a constant for the request envelope (generous). */
const TOKENS_PER_MESSAGE = 4;
const TOKENS_PER_REQUEST = 16;

function tokensOf(n: number | null | undefined): bigint {
  return BigInt(Math.max(0, Math.ceil(Number.isFinite(n ?? NaN) ? (n as number) : 0)));
}

/** The price entry's fee, else the deployment's OpenRouter fee. */
export function feeBpsOf(price: ModelPrice, defaultFeeBps: number): number {
  return price.feeBps ?? defaultFeeBps;
}

/** The input of a request, as the bounds below read it. */
export interface InputOf {
  system: string | null;
  messages: readonly ChatMessage[];
  /** Sent after the history (`GenerateRequest.turnInstructions`), at most as a message of its own. */
  turnInstructions?: string;
}

/**
 * An upper bound on the input tokens of a request: byte-level BPE tokenizers
 * never emit more tokens than input bytes, so the UTF-8 length (plus framing)
 * bounds any of them, where chars/3.5 (core/tokens.ts) does not.
 */
export function inputBoundTokens(request: InputOf): number {
  let bytes = request.system === null ? 0 : utf8Bytes(request.system);
  let messages = request.messages.length;
  for (const m of request.messages) bytes += utf8Bytes(m.content);
  if (request.turnInstructions) {
    bytes += utf8Bytes(request.turnInstructions);
    messages++;
  }
  return bytes + TOKENS_PER_MESSAGE * messages + TOKENS_PER_REQUEST;
}

/**
 * The system, summary and anchor sections a prompt's allowance makes room
 * for (`renderOverheadBytes`): a chain of quoted tangents this deep. A deeper
 * one can outgrow the pool's limit, and is refused like any request over it.
 */
const PROMPT_SECTIONS = 32;

/**
 * What rendering adds to a prompt outside its context budget, in UTF-8 bytes
 * (an upper bound on tokens too): headings, anchor tags, the continuation
 * message and per-reply instructions (`renderOverheadBytes` for
 * `PROMPT_SECTIONS`), and the framing of each message added that way (an
 * anchor quote per section, the continuation message, the folded system text
 * and the reply instructions) and of the request. `sends.replyLength`: whether
 * the call can carry Learn's reply-length instructions (never on the pool).
 */
export function renderAllowanceBytes(sends: { replyLength: boolean }): number {
  return (
    renderOverheadBytes(PROMPT_SECTIONS, sends) +
    TOKENS_PER_MESSAGE * (PROMPT_SECTIONS + 3) +
    TOKENS_PER_REQUEST
  );
}

/**
 * The most input tokens a pool request may have (`exceedsInputLimit`
 * refuses more instead of clamping its hold), so the reply's ceiling hold
 * (`ceilingHoldMicros`) bounds every pool call. The pool's context budget,
 * `maxInputTokens` (`POOL_MAX_INPUT_TOKENS`), is measured in UTF-8 bytes / 3.5
 * (core's `estimateTokensUtf8`), so a prompt within it holds at most
 * 3.5 × `maxInputTokens` bytes of segment text and framing, plus what
 * rendering adds outside the budget (`renderAllowanceBytes`, without Learn's
 * reply-length instructions: the pool ignores Learn's reply settings). At most the
 * price entry's context window.
 */
export function poolInputLimitTokens(price: ModelPrice, maxInputTokens: number): number {
  return Math.min(
    price.contextTokens,
    Math.ceil(maxInputTokens * CHARS_PER_TOKEN) + renderAllowanceBytes({ replyLength: false }),
  );
}

/** Whether a request's input bound exceeds `limitTokens` (the pool refuses it). */
export function exceedsInputLimit(limitTokens: number, request: InputOf): boolean {
  return inputBoundTokens(request) > limitTokens;
}

/**
 * The rates a call with `inputTokens` in is priced at: the long-context
 * tier's (`ModelPrice.longContext`) once its input is over the tier's
 * threshold, the whole call at them as the provider bills it; else the base
 * rates. The tier's unset cache prices fall back to its own input price, never
 * the base ones, so no token is priced below what it costs there.
 */
function priceForInput(price: ModelPrice, inputTokens: number | null): ModelPrice {
  const long = price.longContext;
  if (!long || tokensOf(inputTokens) <= BigInt(long.aboveInputTokens)) return price;
  return {
    inMicrosPerMTok: long.inMicrosPerMTok,
    outMicrosPerMTok: long.outMicrosPerMTok,
    contextTokens: price.contextTokens,
    ...(price.feeBps !== undefined ? { feeBps: price.feeBps } : {}),
    ...(long.cacheReadMicrosPerMTok !== undefined
      ? { cacheReadMicrosPerMTok: long.cacheReadMicrosPerMTok }
      : {}),
    ...(long.cacheWriteMicrosPerMTok !== undefined
      ? { cacheWriteMicrosPerMTok: long.cacheWriteMicrosPerMTok }
      : {}),
  };
}

/**
 * The most one input token can cost: the input price, or the cache-write
 * price when that is higher (a prompt-cached request may write all its input).
 */
export function maxInputMicrosPerMTok(price: ModelPrice): number {
  return Math.max(price.inMicrosPerMTok, price.cacheWriteMicrosPerMTok ?? 0);
}

/**
 * A bound on the true cost of `inputTokens` in (at `maxInputMicrosPerMTok`)
 * and `outputTokens` out, in micro-USD, with the fee and no markup, at the
 * rates of that much input (`priceForInput`). Rounded
 * as a token-priced settle is (to nano-USD, then up to micro-USD,
 * `chargeFromTokensMicros`): a single rounding can come out a micro-dollar
 * below that settle.
 */
function priceMicros(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
  feeBps: number,
): number {
  const rates = priceForInput(price, inputTokens);
  const raw =
    tokensOf(inputTokens) * BigInt(maxInputMicrosPerMTok(rates)) +
    tokensOf(outputTokens) * BigInt(rates.outMicrosPerMTok);
  return chargeMicros(nanosOfRaw(raw), 0, feeBps);
}

/** A price in micro-USD × 10⁶ (µ$/MTok × tokens) as nano-USD, rounded up. */
function nanosOfRaw(raw: bigint): number {
  return Number((raw + 999n) / 1000n);
}

/**
 * The most a request can cost on the pool, in micro-USD: its input bound
 * (at most the context window; see `exceedsInputLimit`) and `maxOutputTokens`
 * at the model's price, grossed up by its fee, rounded up.
 */
export function worstCaseHoldMicros(
  price: ModelPrice,
  request: InputOf,
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
 * The reply's hold before its prompt is assembled: the pool's input limit
 * in (`poolInputLimitTokens`), `maxOutputTokens` out. Never below the worst
 * case of any pool request the limit admits on the same model and output cap.
 */
export function ceilingHoldMicros(
  price: ModelPrice,
  maxInputTokens: number,
  maxOutputTokens: number,
  defaultFeeBps: number,
): number {
  return priceMicros(
    price,
    poolInputLimitTokens(price, maxInputTokens),
    maxOutputTokens,
    feeBpsOf(price, defaultFeeBps),
  );
}

/** The prompt-cache share of a call's input tokens, as the provider reported it (null = not reported). */
export interface CacheTokens {
  readTokens?: number | null;
  writeTokens?: number | null;
}

/**
 * The input side of a token-priced cost, in micro-USD × 10⁶: cache reads at
 * the read price, cache writes at the write price, the rest at the input
 * price. Input whose cache share is unknown (no report, or reads without
 * writes) is priced at `maxInputMicrosPerMTok`, so it is never undercharged.
 */
function inputRaw(price: ModelPrice, inputTokens: number | null, cache: CacheTokens): bigint {
  const total = tokensOf(inputTokens);
  const read = minBig(tokensOf(cache.readTokens), total);
  const readRaw = read * BigInt(price.cacheReadMicrosPerMTok ?? price.inMicrosPerMTok);
  if (cache.writeTokens === null || cache.writeTokens === undefined) {
    return readRaw + (total - read) * BigInt(maxInputMicrosPerMTok(price));
  }
  const write = minBig(tokensOf(cache.writeTokens), total - read);
  return (
    readRaw +
    write * BigInt(price.cacheWriteMicrosPerMTok ?? price.inMicrosPerMTok) +
    (total - read - write) * BigInt(price.inMicrosPerMTok)
  );
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * The model price of `inputTokens` in (of which `cache` was read from or
 * written to the prompt cache) and `outputTokens` out, at the rates of that
 * much input (`priceForInput`), in nano-USD (rounded up), before fees.
 */
export function costFromTokensNanos(
  price: ModelPrice,
  inputTokens: number | null,
  outputTokens: number | null,
  cache: CacheTokens = {},
): number {
  const rates = priceForInput(price, inputTokens);
  // µ$/MTok × tokens / 10⁶ = µ$; × 1000 = n$.
  const raw =
    inputRaw(rates, inputTokens, cache) + tokensOf(outputTokens) * BigInt(rates.outMicrosPerMTok);
  return nanosOfRaw(raw);
}

/** What a token-priced call is charged: its true cost plus `markupBps` (0 on the pool). */
export function chargeFromTokensMicros(
  price: ModelPrice,
  inputTokens: number | null,
  outputTokens: number | null,
  feeBps: number,
  markupBps: number,
  cache: CacheTokens = {},
): number {
  return chargeMicros(
    costFromTokensNanos(price, inputTokens, outputTokens, cache),
    markupBps,
    feeBps,
  );
}
