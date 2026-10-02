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
    // No OpenRouter fee: 1_234_000 nano × 1.10 = 1357.4 micro → 1358.
    expect(chargeMicros(1_234_000, 1000, 0)).toBe(1358);
    // × 1.05 = 1295.7 → 1296.
    expect(chargeMicros(1_234_000, 500, 0)).toBe(1296);
    // Exact results are not bumped.
    expect(chargeMicros(1_000_000_000, 1000, 0)).toBe(1_100_000);
    expect(chargeMicros(1_000_000_000, 500, 0)).toBe(1_050_000);
    expect(chargeMicros(1_000_000, 0, 0)).toBe(1000);
    // Any positive cost charges at least 1 micro-USD.
    expect(chargeMicros(1, 0, 0)).toBe(1);
    expect(chargeMicros(1, 1000, 550)).toBe(1);
    expect(chargeMicros(1001, 0, 0)).toBe(2);
    expect(chargeMicros(0, 1000, 550)).toBe(0);
    expect(chargeMicros(-5, 1000, 550)).toBe(0);
  });

  it('grosses the reported cost up by the OpenRouter fee before the markup', () => {
    // $0.001 reported: 1_000_000 nano × 1.055 × 1.10 = 1_160_500 nano → 1160.5 micro → 1161.
    expect(chargeMicros(costUsdToNanos(0.001), 1000, 550)).toBe(1161);
    // Monthly plan: × 1.055 × 1.05 = 1107.75 → 1108.
    expect(chargeMicros(1_000_000, 500, 550)).toBe(1108);
    // The fee alone is a pass-through: × 1.055, exact.
    expect(chargeMicros(1_000_000, 0, 550)).toBe(1055);
    // $1: 1.055 × 1.10 = $1.1605 exactly.
    expect(chargeMicros(1_000_000_000, 1000, 550)).toBe(1_160_500);
    // 1_234_000 × 1.055 × 1.10 = 1_432_057 nano → 1433 (never rounded down).
    expect(chargeMicros(1_234_000, 1000, 550)).toBe(1433);
    // Nonsense bps count as 0.
    expect(chargeMicros(1_000_000, Number.NaN, -5)).toBe(1000);
  });

  it('stays exact for costs whose product exceeds 2^53', () => {
    const nanos = 999_999_999_999_999; // ~$1M
    const expected = (BigInt(nanos) * 10_550n * 10_500n + 99_999_999_999n) / 100_000_000_000n;
    expect(Number.isSafeInteger(nanos * 10_550 * 10_500)).toBe(false);
    expect(chargeMicros(nanos, 500, 550)).toBe(Number(expected));
    expect(chargeMicros(1e15, 1000, 0)).toBe(1_100_000_000_000);
    expect(chargeMicros(1e15, 1000, 550)).toBe(1_160_500_000_000);
  });

  it('converts cents to micro-USD', () => {
    expect(centsToMicros(500)).toBe(5_000_000);
    expect(centsToMicros(50_000)).toBe(500_000_000);
    expect(centsToMicros(-1100)).toBe(-11_000_000);
    expect(centsToMicros(0)).toBe(0);
  });
});
