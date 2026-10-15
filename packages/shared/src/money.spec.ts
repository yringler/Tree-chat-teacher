import { describe, expect, it } from 'vitest';
import { formatServiceFee } from './money.js';

describe('formatServiceFee', () => {
  it('reads as a percentage plus a fixed amount', () => {
    expect(formatServiceFee({ bps: 2000, fixedCents: 50 })).toBe('20% + 50¢');
    expect(formatServiceFee({ bps: 1250, fixedCents: 100 })).toBe('12.5% + $1');
    expect(formatServiceFee({ bps: 1500, fixedCents: 125 })).toBe('15% + $1.25');
  });

  it('leaves out a zero part', () => {
    expect(formatServiceFee({ bps: 2000, fixedCents: 0 })).toBe('20%');
    expect(formatServiceFee({ bps: 0, fixedCents: 50 })).toBe('50¢');
    expect(formatServiceFee({ bps: 0, fixedCents: 0 })).toBe('0%');
  });
});
