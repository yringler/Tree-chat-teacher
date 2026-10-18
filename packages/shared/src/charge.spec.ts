import { describe, expect, it } from 'vitest';
import {
  centsToMicros,
  chargeMicros,
  costUsdToNanos,
  DEFAULT_SERVICE_FEE,
  serviceFeeCents,
} from './charge.js';

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
    // A 5% markup: × 1.055 × 1.05 = 1107.75 → 1108.
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

describe('serviceFeeCents', () => {
  it('is the percentage plus the fixed part, at the defaults 20% + 50¢', () => {
    expect(serviceFeeCents(500, DEFAULT_SERVICE_FEE)).toBe(150);
    expect(serviceFeeCents(1000, DEFAULT_SERVICE_FEE)).toBe(250);
    expect(serviceFeeCents(50_000, DEFAULT_SERVICE_FEE)).toBe(10_050);
  });

  it('rounds the percentage up to a whole cent', () => {
    // 20% of $7.33 is 146.6¢.
    expect(serviceFeeCents(733, { bps: 2000, fixedCents: 0 })).toBe(147);
    expect(serviceFeeCents(733, { bps: 2000, fixedCents: 50 })).toBe(197);
  });

  it('charges nothing for nothing, and counts nonsense rates as 0', () => {
    expect(serviceFeeCents(0, DEFAULT_SERVICE_FEE)).toBe(0);
    expect(serviceFeeCents(-500, DEFAULT_SERVICE_FEE)).toBe(0);
    expect(serviceFeeCents(500, { bps: -5, fixedCents: Number.NaN })).toBe(0);
    expect(serviceFeeCents(500, { bps: 0, fixedCents: 0 })).toBe(0);
  });
});

/** A seeded PRNG (mulberry32), so a failing case reproduces. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('chargeMicros properties', () => {
  const rand = seeded(20261018);
  /** A whole number in [0, max], skewed small so the rounding edges come up. */
  const int = (max: number): number => Math.floor(rand() ** 3 * (max + 1));
  const cases = Array.from({ length: 5000 }, () => ({
    nanos: int(50_000_000_000),
    markup: int(5000),
    fee: int(2000),
  }));

  it('is a whole number at least the cost rounded up to a micro-dollar, 0 only for no cost', () => {
    for (const { nanos, markup, fee } of cases) {
      const charge = chargeMicros(nanos, markup, fee);
      expect(Number.isSafeInteger(charge)).toBe(true);
      expect(charge).toBeGreaterThanOrEqual(Math.ceil(nanos / 1000));
      expect(charge === 0).toBe(nanos === 0);
    }
    for (const cost of [0, -1, -1e12, Number.NaN, Number.NEGATIVE_INFINITY])
      expect(chargeMicros(cost, 1000, 550)).toBe(0);
  });

  it('never falls as the cost, the markup or the fee rises', () => {
    for (const { nanos, markup, fee } of cases) {
      const charge = chargeMicros(nanos, markup, fee);
      expect(chargeMicros(nanos + 1 + int(1000), markup, fee)).toBeGreaterThanOrEqual(charge);
      expect(chargeMicros(nanos, markup + 1 + int(100), fee)).toBeGreaterThanOrEqual(charge);
      expect(chargeMicros(nanos, markup, fee + 1 + int(100))).toBeGreaterThanOrEqual(charge);
    }
  });

  it('rounds a fractional cost to the nearest nano-dollar first (costs are whole nanos)', () => {
    expect(chargeMicros(0.4, 0, 0)).toBe(0);
    expect(chargeMicros(0.6, 0, 0)).toBe(1);
  });
});

describe('serviceFeeCents properties', () => {
  const rand = seeded(42);
  const int = (max: number): number => Math.floor(rand() ** 2 * (max + 1));
  const cases = Array.from({ length: 5000 }, () => ({
    credit: int(1_000_000),
    fee: { bps: int(5000), fixedCents: int(200) },
  }));

  it('is the fixed part plus the percentage rounded up to a cent, 0 for no credit', () => {
    for (const { credit, fee } of cases) {
      const cents = serviceFeeCents(credit, fee);
      expect(Number.isSafeInteger(cents)).toBe(true);
      const exact = fee.fixedCents + (credit * fee.bps) / 10_000;
      if (credit === 0) expect(cents).toBe(0);
      else {
        expect(cents).toBeGreaterThanOrEqual(exact);
        expect(cents).toBeLessThan(exact + 1);
      }
    }
    for (const credit of [-1, -500, 0.5, Number.NaN])
      expect(serviceFeeCents(credit, DEFAULT_SERVICE_FEE)).toBe(0);
  });

  it('never falls as the credit, the rate or the fixed part rises', () => {
    for (const { credit, fee } of cases) {
      const cents = serviceFeeCents(credit, fee);
      const more = 1 + int(1000);
      expect(serviceFeeCents(credit + more, fee)).toBeGreaterThanOrEqual(cents);
      expect(serviceFeeCents(credit, { ...fee, bps: fee.bps + more })).toBeGreaterThanOrEqual(
        cents,
      );
      expect(
        serviceFeeCents(credit, { ...fee, fixedCents: fee.fixedCents + more }),
      ).toBeGreaterThanOrEqual(cents);
    }
  });
});
