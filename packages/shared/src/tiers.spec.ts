import { describe, expect, it } from 'vitest';
import type { ModelInfo } from './provider.js';
import {
  compareUsageNote,
  MAX_USAGE_FACTOR_FALLBACK,
  maxUsageNote,
  TIER_LABELS,
  TIERS,
  tierModel,
  tierOf,
  usageFactorOf,
} from './tiers.js';

const PRO = { inMicrosPerMTok: 955_260, outMicrosPerMTok: 1_910_520 };
const FLASH = { inMicrosPerMTok: 150_000, outMicrosPerMTok: 600_000 };
const SONNET = { inMicrosPerMTok: 2_000_000, outMicrosPerMTok: 10_000_000 };

describe('tiers', () => {
  it('names both tiers, Normal first', () => {
    expect(TIERS).toEqual(['normal', 'max']);
    expect(TIERS.map((t) => TIER_LABELS[t])).toEqual(['Normal', 'Max']);
  });

  it("falls back to the default models' factor", () => {
    expect(MAX_USAGE_FACTOR_FALLBACK).toBe(usageFactorOf(FLASH, SONNET));
  });

  it('usageFactorOf weighs input 10:1 and rounds to a whole number >= 1', () => {
    // (10·2 + 10) / (10·0.15 + 0.6) = 30 / 2.1 ≈ 14.3
    expect(usageFactorOf(FLASH, SONNET)).toBe(14);
    expect(usageFactorOf(PRO, SONNET)).toBe(3);
    expect(usageFactorOf(PRO, PRO)).toBe(1);
    // A cheaper "Max" never reads as less than Normal.
    expect(usageFactorOf(SONNET, PRO)).toBe(1);
  });

  it('usageFactorOf is null when the prices cannot tell', () => {
    expect(usageFactorOf({ inMicrosPerMTok: 0, outMicrosPerMTok: 0 }, SONNET)).toBeNull();
    expect(usageFactorOf({ inMicrosPerMTok: Number.NaN, outMicrosPerMTok: 1 }, SONNET)).toBeNull();
    expect(
      usageFactorOf(PRO, { inMicrosPerMTok: Number.POSITIVE_INFINITY, outMicrosPerMTok: 1 }),
    ).toBeNull();
  });

  it('finds a tier model and a model tier by data, not label', () => {
    const models: ModelInfo[] = [
      { id: 'vendor/pro', label: 'Max', tier: 'normal' },
      { id: 'vendor/sonnet', label: 'Whatever', tier: 'max', usageFactor: 3 },
      { id: 'vendor/flash', label: 'Normal' },
    ];
    expect(tierModel(models, 'normal')?.id).toBe('vendor/pro');
    expect(tierModel(models, 'max')?.id).toBe('vendor/sonnet');
    expect(tierModel([], 'max')).toBeUndefined();
    expect(tierOf(models, 'vendor/sonnet')).toBe('max');
    expect(tierOf(models, 'vendor/pro')).toBe('normal');
    expect(tierOf(models, 'vendor/flash')).toBeNull();
    expect(tierOf(models, 'vendor/unlisted')).toBeNull();
    expect(tierOf(models, null)).toBeNull();
    expect(tierOf(models, undefined)).toBeNull();
  });

  it('words the usage notes from the factor, vaguely when it is unknown or small', () => {
    expect(maxUsageNote(3)).toBe('Max uses about 3× as much as Normal.');
    expect(maxUsageNote(14)).toBe('Max uses about 14× as much as Normal.');
    expect(maxUsageNote(1)).toBe('Max uses more than Normal.');
    expect(maxUsageNote(undefined)).toBe('Max uses more than Normal.');
    expect(compareUsageNote(3)).toBe(
      'Both models answer, so comparing uses about 4× a Normal reply. Only the answer you pick is kept.',
    );
    expect(compareUsageNote(14)).toBe(
      'Both models answer, so comparing uses about 15× a Normal reply. Only the answer you pick is kept.',
    );
    for (const factor of [1, undefined])
      expect(compareUsageNote(factor)).toBe(
        'Both models answer, so comparing uses both models. Only the answer you pick is kept.',
      );
  });
});
