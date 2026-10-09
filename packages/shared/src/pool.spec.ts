import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_POOL_COPY,
  POOL_AT_COST_TEXT,
  POOL_BLOCK_REASONS,
  POOL_EMPTY_TEXT,
  POOL_FUNDING_TEXT,
  poolBlockDetailsSchema,
  poolErrorCode,
  poolModelDifferences,
  poolModelText,
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

  it('never offers pool credit for sale', () => {
    for (const text of [POOL_FUNDING_TEXT, POOL_EMPTY_TEXT, POOL_AT_COST_TEXT])
      expect(text).not.toMatch(/buy|purchase|fund the pool|people fund/i);
    expect(POOL_EMPTY_TEXT).toBe('The open pool is empty until Tangent adds more credit.');
    expect(POOL_AT_COST_TEXT).toContain('with no markup');
  });

  it('never calls the pool a donation', () => {
    for (const text of [
      POOL_EMPTY_TEXT,
      POOL_AT_COST_TEXT,
      POOL_FUNDING_TEXT,
      poolSessionsText(10),
    ])
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

describe('poolModelText', () => {
  const normal = { id: 'deepseek/deepseek-v4.1-flash', label: 'Normal' };

  it("is the label when the pool asks the tier's model the same way, or runs a model of its own", () => {
    expect(poolModelText(normal)).toBe('Normal');
    expect(poolModelText({ id: 'x/lite', label: 'Lite' })).toBe('Lite');
  });

  it("says how the pool asks the tier's model differently", () => {
    const pool = { ...normal, thinking: 'lighter', replies: 'shorter' } as const;
    expect(poolModelText(pool)).toBe("Normal's model with lighter thinking and shorter replies");
    expect(poolModelText({ ...normal, thinking: 'more' })).toBe(
      "Normal's model with more thinking",
    );
    expect(poolModelText({ ...normal, thinking: 'other' })).toBe(
      "Normal's model with a different thinking setting",
    );
    expect(poolModelText({ ...normal, replies: 'longer' })).toBe(
      "Normal's model with longer replies",
    );
  });

  it('leaves the replies out for copy that states the cap', () => {
    const pool = { ...normal, thinking: 'lighter', replies: 'shorter' } as const;
    expect(poolModelDifferences(pool, { replies: false })).toEqual(['lighter thinking']);
    expect(poolModelText(pool, { replies: false })).toBe("Normal's model with lighter thinking");
    expect(poolModelText({ ...normal, replies: 'shorter' }, { replies: false })).toBe('Normal');
  });
});
