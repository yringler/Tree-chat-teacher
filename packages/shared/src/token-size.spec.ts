import { describe, expect, it } from 'vitest';
import {
  describeTokenSize,
  formatUsdEstimate,
  inputCostUsd,
  lengthComparison,
  roughWords,
  roundEstimate,
  tokenSize,
  tokensToPages,
  tokensToWords,
} from './token-size.js';

describe('token conversions', () => {
  it('reads ¾ of a word a token and 275 words a paperback page', () => {
    expect(tokensToWords(60_000)).toBe(45_000);
    expect(tokensToPages(60_000)).toBeCloseTo(163.6, 1);
    expect(tokensToPages(200_000)).toBeCloseTo(545.5, 1);
  });

  it('rounds estimates to two significant figures, never below the floor', () => {
    expect(roundEstimate(45_000)).toBe(45_000);
    expect(roundEstimate(163.6)).toBe(160);
    expect(roundEstimate(545.45)).toBe(550);
    expect(roundEstimate(9258.75)).toBe(9300);
    expect(roundEstimate(2.727)).toBe(2.7);
    expect(roundEstimate(0, 1)).toBe(1);
    expect(roundEstimate(0.2, 1)).toBe(1);
  });

  it('keeps the public pages’ rough words (moved from the landing page)', () => {
    expect(roughWords(1024)).toBe('750');
    expect(roughWords(8192)).toBe('6,150');
    expect(roughWords(10)).toBe('50');
  });

  it('compares a length with kinds of book', () => {
    expect(lengthComparison(750)).toBe('a short essay');
    expect(lengthComparison(3000)).toBe('a short story');
    expect(lengthComparison(12_000)).toBe('a novelette');
    expect(lengthComparison(24_000)).toBe('a novella');
    expect(lengthComparison(45_000)).toBe('a short novel');
    expect(lengthComparison(96_000)).toBe('a novel');
    expect(lengthComparison(150_000)).toBe('a long novel');
    expect(lengthComparison(750_000)).toBe('8 novels');
  });

  it('describes a token count in one sentence', () => {
    expect(tokenSize(60_000)).toEqual({ words: 45_000, pages: 160, like: 'a short novel' });
    expect(describeTokenSize(60_000)).toBe(
      '60,000 tokens ≈ 45,000 words ≈ 160 paperback pages, about the length of a short novel.',
    );
    expect(describeTokenSize(200_000)).toBe(
      '200,000 tokens ≈ 150,000 words ≈ 550 paperback pages, about the length of a long novel.',
    );
    expect(describeTokenSize(1000)).toBe(
      '1,000 tokens ≈ 750 words ≈ 2.7 paperback pages, about the length of a short essay.',
    );
    expect(describeTokenSize(300)).toContain('≈ 1 paperback page,');
  });
});

describe('input cost', () => {
  it('prices tokens per million', () => {
    expect(inputCostUsd(60_000, 2)).toBeCloseTo(0.12);
    expect(inputCostUsd(1_000_000, 0.3)).toBeCloseTo(0.3);
  });

  it('formats an estimate: cents from 10¢, two significant figures below', () => {
    expect(formatUsdEstimate(0.12)).toBe('$0.12');
    expect(formatUsdEstimate(3.4)).toBe('$3.40');
    expect(formatUsdEstimate(1234.5)).toBe('$1,234.50');
    expect(formatUsdEstimate(0.012)).toBe('$0.012');
    expect(formatUsdEstimate(0.0012345)).toBe('$0.0012');
    expect(formatUsdEstimate(0.0999)).toBe('$0.10');
    expect(formatUsdEstimate(0)).toBe('$0');
  });
});
