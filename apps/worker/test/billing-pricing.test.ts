import { describe, expect, it } from 'vitest';
import { centsToMicros, chargeMicros, costUsdToNanos } from '../src/billing/pricing.js';

describe('billing pricing', () => {
  it('converts USD cost to integer nano-USD, rounding to nearest', () => {
    expect(costUsdToNanos(0.001234)).toBe(1_234_000);
    expect(costUsdToNanos(1)).toBe(1_000_000_000);
    expect(costUsdToNanos(0.1 + 0.2)).toBe(300_000_000);
    expect(costUsdToNanos(0.0000000004)).toBe(0);
    expect(costUsdToNanos(0.0000000006)).toBe(1);
    expect(costUsdToNanos(0)).toBe(0);
    expect(costUsdToNanos(-1)).toBe(0);
    expect(costUsdToNanos(Number.NaN)).toBe(0);
    expect(costUsdToNanos(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('applies the markup and rounds the charge up to a whole micro-USD', () => {
    // 1_234_000 nano × 1.10 = 1357.4 micro → 1358.
    expect(chargeMicros(1_234_000, 1000)).toBe(1358);
    // × 1.05 = 1295.7 → 1296.
    expect(chargeMicros(1_234_000, 500)).toBe(1296);
    // Exact results are not bumped.
    expect(chargeMicros(1_000_000_000, 1000)).toBe(1_100_000);
    expect(chargeMicros(1_000_000_000, 500)).toBe(1_050_000);
    expect(chargeMicros(1_000_000, 0)).toBe(1000);
    // Any positive cost charges at least 1 micro-USD.
    expect(chargeMicros(1, 0)).toBe(1);
    expect(chargeMicros(1, 1000)).toBe(1);
    expect(chargeMicros(1001, 0)).toBe(2);
    expect(chargeMicros(0, 1000)).toBe(0);
    expect(chargeMicros(-5, 1000)).toBe(0);
  });

  it('stays exact for costs whose product exceeds 2^53', () => {
    const nanos = 999_999_999_999_999; // ~$1M
    const expected = (BigInt(nanos) * 10_500n + 9_999_999n) / 10_000_000n;
    expect(Number.isSafeInteger(nanos * 10_500)).toBe(false);
    expect(chargeMicros(nanos, 500)).toBe(Number(expected));
    expect(chargeMicros(1e15, 1000)).toBe(1_100_000_000_000);
  });

  it('converts cents to micro-USD', () => {
    expect(centsToMicros(500)).toBe(5_000_000);
    expect(centsToMicros(50_000)).toBe(500_000_000);
    expect(centsToMicros(-1100)).toBe(-11_000_000);
    expect(centsToMicros(0)).toBe(0);
  });
});
