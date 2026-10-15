// Integer money math: provider cost in nano-USD, ledger in
// micro-USD, charges rounded up, never down. The Worker's meter and the
// demos' pretend credit charge with the same functions.

/** OpenRouter's fee on credit purchases (5.5%; higher for top-ups under ~$15, see docs/configuration.md). */
export const DEFAULT_OPENROUTER_FEE_BPS = 550;

/**
 * The fee on a credit purchase: `bps` of the credit bought plus `fixedCents`.
 * Tangent's margin, and what pays OpenRouter's and the payment processor's
 * fees, so credit itself buys usage at the models' listed prices.
 */
export interface ServiceFee {
  bps: number;
  fixedCents: number;
}

/** 20% + 50¢ (`SERVICE_FEE_BPS`, `SERVICE_FEE_FIXED_CENTS` on the server). */
export const DEFAULT_SERVICE_FEE: ServiceFee = { bps: 2000, fixedCents: 50 };

/**
 * The service fee on buying `creditCents` of credit, in cents: the percentage
 * rounded up to a whole cent, plus the fixed part. The buyer pays
 * `creditCents` plus this, before tax. Nothing for nothing; nonsense rates count as 0.
 */
export function serviceFeeCents(creditCents: number, fee: ServiceFee): number {
  if (!Number.isSafeInteger(creditCents) || creditCents <= 0) return 0;
  const bps = Math.max(0, Math.round(Number.isFinite(fee.bps) ? fee.bps : 0));
  const fixed = Math.max(0, Math.round(Number.isFinite(fee.fixedCents) ? fee.fixedCents : 0));
  return Math.ceil((creditCents * bps) / 10_000) + fixed;
}

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
