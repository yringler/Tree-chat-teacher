// Integer money math: provider cost in nano-USD, ledger in
// micro-USD, charges rounded up, never down. The Worker's meter and the
// demos' pretend credit charge with the same functions.

/** The margin on Tangent credit by default (+10%), MARKUP_BPS on the server. */
export const DEFAULT_MARKUP_BPS = 1000;
/** OpenRouter's fee on credit purchases (5.5%; higher for top-ups under ~$15, see docs/configuration.md). */
export const DEFAULT_OPENROUTER_FEE_BPS = 550;

const NANOS_PER_USD = 1e9;
/** 100% in basis points. */
export const BPS_SCALE = 10_000n;
/** 1 micro-USD = 1000 nano-USD; × 10_000² for the two bps factors. */
const CHARGE_DIVISOR = 100_000_000_000n;

/** `Math.round(costUsd * 1e9)`; non-finite or negative costs count as 0. */
export function costUsdToNanos(costUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
  return Math.round(costUsd * NANOS_PER_USD);
}

/** A bps rate as a BigInt factor; negative or non-finite rates count as 0. */
export function bpsOf(bps: number): bigint {
  return BigInt(Math.max(0, Math.round(Number.isFinite(bps) ? bps : 0)));
}

/**
 * What a call costs the user, in micro-USD:
 *
 *   ceil(costNanos × (10_000 + feeBps) × (10_000 + markupBps) / 10^8 / 1000)
 *
 * `costNanos` is the model price OpenRouter reports; `feeBps` grosses it up by
 * OpenRouter's credit-purchase fee, so the result's base is the operator's true
 * cost; `markupBps` is the margin on top. Exact integer (BigInt) math, so large
 * costs never lose precision. Never rounds down.
 */
export function chargeMicros(costNanos: number, markupBps: number, feeBps: number): number {
  if (!Number.isFinite(costNanos) || costNanos <= 0) return 0;
  const nanos = BigInt(Math.round(costNanos));
  const numerator = nanos * (BPS_SCALE + bpsOf(feeBps)) * (BPS_SCALE + bpsOf(markupBps));
  return Number((numerator + CHARGE_DIVISOR - 1n) / CHARGE_DIVISOR);
}

/** `cents * 10_000`. */
export function centsToMicros(cents: number): number {
  return Math.round(cents) * 10_000;
}
