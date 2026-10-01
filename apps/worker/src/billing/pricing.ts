// Integer money math (PLAN §2.3): provider cost in nano-USD, ledger in
// micro-USD, charges rounded up, never down.

const NANOS_PER_USD = 1e9;
const BPS_SCALE = 10_000n;
/** 1 micro-USD = 1000 nano-USD; × 10_000 for the bps scale. */
const CHARGE_DIVISOR = 10_000_000n;

/** `Math.round(costUsd * 1e9)`; non-finite or negative costs count as 0. */
export function costUsdToNanos(costUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
  return Math.round(costUsd * NANOS_PER_USD);
}

/**
 * `ceil(costNanos * (10_000 + markupBps) / 10_000_000)`, in exact integer
 * (BigInt) math so large costs never lose precision. Never rounds down.
 */
export function chargeMicros(costNanos: number, markupBps: number): number {
  if (!Number.isFinite(costNanos) || costNanos <= 0) return 0;
  const nanos = BigInt(Math.round(costNanos));
  const bps = BigInt(Math.max(0, Math.round(Number.isFinite(markupBps) ? markupBps : 0)));
  const numerator = nanos * (BPS_SCALE + bps);
  return Number((numerator + CHARGE_DIVISOR - 1n) / CHARGE_DIVISOR);
}

/** `cents * 10_000`. */
export function centsToMicros(cents: number): number {
  return Math.round(cents) * 10_000;
}
