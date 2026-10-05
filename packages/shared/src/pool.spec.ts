import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_POOL_COPY,
  POOL_BLOCK_REASONS,
  POOL_EMPTY_TEXT,
  POOL_NOTICE_TEXT,
  POOL_NOTICE_VERSION,
  poolBlockDetailsSchema,
  poolConsentRequestSchema,
  poolErrorCode,
  poolMarginText,
  poolSessionsText,
} from './pool.js';

describe('poolErrorCode', () => {
  it('maps every refusal to empty (402), cap reached (429) or unavailable (403)', () => {
    expect(POOL_BLOCK_REASONS.map((r) => [r, poolErrorCode(r)])).toEqual([
      ['empty', 'pool_empty'],
      ['cap_requests', 'pool_cap_reached'],
      ['cap_spend', 'pool_cap_reached'],
      ['cap_ip', 'pool_cap_reached'],
      ['cap_global', 'pool_cap_reached'],
      ['rate', 'pool_cap_reached'],
      ['unpriced', 'pool_empty'],
      ['suspended', 'pool_unavailable'],
      ['verify', 'pool_unavailable'],
      ['duplicate_identity', 'pool_unavailable'],
      ['too_new', 'pool_unavailable'],
    ]);
  });
});

describe('poolBlockDetailsSchema', () => {
  it('accepts what the server sends and rejects unknown reasons', () => {
    const details = {
      reason: 'cap_requests',
      limit: 30,
      resetAt: '2026-10-06T00:00:00.000Z',
      supporter: false,
      supporterLimit: 150,
    };
    expect(poolBlockDetailsSchema.parse(details)).toEqual(details);
    expect(poolBlockDetailsSchema.safeParse({ ...details, reason: 'nope' }).success).toBe(false);
  });
});

describe('pool copy', () => {
  it('counts learning sessions, approximately', () => {
    expect(poolSessionsText(1240)).toBe('about 1,240 learning sessions');
    expect(poolSessionsText(1)).toBe('about 1 learning session');
    expect(poolSessionsText(0)).toBe('no learning sessions');
    expect(poolSessionsText(-3)).toBe('no learning sessions');
    expect(poolSessionsText(2.9)).toBe('about 2 learning sessions');
  });

  it('discloses the margin in one line', () => {
    expect(poolMarginText(800)).toBe(
      '8% covers card processing, hosting and keeps Tangent running.',
    );
    expect(poolMarginText(750)).toMatch(/^7\.5% covers/);
  });

  it('never calls funding a donation', () => {
    for (const text of [POOL_EMPTY_TEXT, poolMarginText(800), poolSessionsText(10)])
      expect(text).not.toMatch(FORBIDDEN_POOL_COPY);
    for (const bad of [
      'Donate',
      'a donation',
      'donors',
      'tax-deductible',
      'Tax deductible',
      'charity',
    ])
      expect(bad).toMatch(FORBIDDEN_POOL_COPY);
  });
});

describe('the pool notice', () => {
  it('says what the stats show and that questions are never shown, within the copy rule', () => {
    expect(POOL_NOTICE_VERSION).toBe(1);
    expect(POOL_NOTICE_TEXT).toContain('aggregate topic stats shown publicly');
    expect(POOL_NOTICE_TEXT).toContain('Your questions are never shown.');
    expect(POOL_NOTICE_TEXT).not.toMatch(FORBIDDEN_POOL_COPY);
  });

  it('is acknowledged by its version, a positive integer', () => {
    expect(poolConsentRequestSchema.parse({ version: 1 })).toEqual({ version: 1 });
    for (const version of [0, -1, 1.5, '1', null])
      expect(poolConsentRequestSchema.safeParse({ version }).success).toBe(false);
  });
});
