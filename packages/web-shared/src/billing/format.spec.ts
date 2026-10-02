import { describe, expect, it } from 'vitest';
import {
  formatBps,
  formatCents,
  formatCharge,
  formatMicros,
  isValidTopUpCents,
  parseDollarsToCents,
  topUpError,
} from './format';

describe('formatMicros', () => {
  it('shows dollars and cents', () => {
    expect(formatMicros(0)).toBe('$0.00');
    expect(formatMicros(1_234_567)).toBe('$1.23');
    expect(formatMicros(5_000_000)).toBe('$5.00');
    expect(formatMicros(1_234_000_000)).toBe('$1,234.00');
  });

  it('rounds to the nearest cent', () => {
    expect(formatMicros(4_999)).toBe('$0.00');
    expect(formatMicros(5_000)).toBe('$0.01');
    expect(formatMicros(1_995_000)).toBe('$2.00');
  });

  it('keeps the sign of a negative balance, but never shows -$0.00', () => {
    expect(formatMicros(-400_000)).toBe('-$0.40');
    expect(formatMicros(-1)).toBe('$0.00');
  });
});

describe('formatCharge', () => {
  it('keeps four decimals under a cent', () => {
    expect(formatCharge(412)).toBe('$0.0004');
    expect(formatCharge(9_000)).toBe('$0.0090');
    expect(formatCharge(1)).toBe('$0.0001');
  });

  it('uses cents from a cent up, and $0.00 for nothing', () => {
    expect(formatCharge(0)).toBe('$0.00');
    expect(formatCharge(10_000)).toBe('$0.01');
    expect(formatCharge(1_250_000)).toBe('$1.25');
  });
});

describe('formatCents', () => {
  it('drops the cents for whole dollars', () => {
    expect(formatCents(500)).toBe('$5');
    expect(formatCents(50_000)).toBe('$500');
    expect(formatCents(1250)).toBe('$12.50');
    expect(formatCents(1)).toBe('$0.01');
  });
});

describe('formatBps', () => {
  it('shows a percentage', () => {
    expect(formatBps(1000)).toBe('10%');
    expect(formatBps(500)).toBe('5%');
    expect(formatBps(750)).toBe('7.5%');
  });
});

describe('parseDollarsToCents', () => {
  it.each([
    ['5', 500],
    ['12.5', 1250],
    ['12.50', 1250],
    ['$12.50', 1250],
    ['$ 7', 700],
    [' 20 ', 2000],
    ['12.', 1200],
    ['.5', 50],
    ['0.99', 99],
    ['1,000', 100_000],
    ['1,000.25', 100_025],
  ])('parses %j as %i cents', (input, cents) => {
    expect(parseDollarsToCents(input)).toBe(cents);
  });

  it.each(['', '   ', '.', '$', 'abc', '-5', '5.999', '1.2.3', '12a', '1,00', '5e3', '+5', '0x10'])(
    'rejects %j',
    (input) => {
      expect(parseDollarsToCents(input)).toBeNull();
    },
  );
});

describe('top-up validation', () => {
  it('accepts whole cents from $5 to $500 by default', () => {
    expect(topUpError(500)).toBeNull();
    expect(topUpError(50_000)).toBeNull();
    expect(topUpError(1234)).toBeNull();
    expect(isValidTopUpCents(500)).toBe(true);
  });

  it('explains what is wrong', () => {
    expect(topUpError(499)).toBe('The smallest top-up is $5.');
    expect(topUpError(50_001)).toBe('The largest top-up is $500.');
    expect(topUpError(null)).toMatch(/Enter an amount/);
    expect(topUpError(500.5)).toMatch(/Enter an amount/);
    expect(isValidTopUpCents(499)).toBe(false);
  });

  it('uses the server limits when given', () => {
    expect(topUpError(1000, 1500, 20_000)).toBe('The smallest top-up is $15.');
    expect(topUpError(25_000, 1500, 20_000)).toBe('The largest top-up is $200.');
  });
});
