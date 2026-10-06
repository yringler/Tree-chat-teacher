import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_POOL_COPY,
  POOL_AT_COST_TEXT,
  POOL_BLOCK_REASONS,
  POOL_EMPTY_TEXT,
  POOL_NOTICE_TEXT,
  POOL_NOTICE_VERSION,
  poolBlockDetailsSchema,
  poolConsentRequestSchema,
  poolErrorCode,
  poolFundingText,
  poolImpactDepthText,
  poolImpactHeadline,
  poolImpactQuerySchema,
  poolImpactTopicText,
  poolImpactWeekText,
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
      member: false,
      memberLimit: 150,
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

  it("states Tangent's revenue share from the configured rate", () => {
    expect(poolFundingText(2000)).toBe(
      "The community pool is free credit Tangent provides. Tangent puts 20% of what it earns into it: 20% of each membership payment after payment fees, and 20% of the markup on credit as it's used.",
    );
    expect(poolFundingText(1250)).toContain('12.5% of each membership payment');
    expect(poolFundingText(0)).toBe('The community pool is free credit Tangent provides.');
  });

  it('never offers pool credit for sale', () => {
    for (const text of [
      poolFundingText(2000),
      poolFundingText(0),
      POOL_EMPTY_TEXT,
      POOL_AT_COST_TEXT,
    ])
      expect(text).not.toMatch(/buy|purchase|fund the pool|people fund/i);
    expect(POOL_EMPTY_TEXT).toBe('The community pool is empty until Tangent adds more credit.');
    expect(POOL_AT_COST_TEXT).toContain('with no markup');
  });

  it('never calls the pool a donation', () => {
    for (const text of [
      POOL_EMPTY_TEXT,
      POOL_AT_COST_TEXT,
      poolFundingText(2000),
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

describe('impact feed copy', () => {
  it('names the week from its Monday, without locale data', () => {
    expect(poolImpactWeekText('2026-09-28')).toBe('the week of 28 September 2026');
    expect(poolImpactWeekText('2027-01-04')).toBe('the week of 4 January 2027');
  });

  it('headlines the exchanges, learners and topics, singular where 1', () => {
    expect(
      poolImpactHeadline({ weekStart: '2026-09-28', exchanges: 1240, learners: 87, topics: 31 }),
    ).toBe(
      'In the week of 28 September 2026 the pool funded 1,240 exchanges for 87 learners across 31 topics.',
    );
    expect(
      poolImpactHeadline({ weekStart: '2026-09-28', exchanges: 1, learners: 1, topics: 1 }),
    ).toBe(
      'In the week of 28 September 2026 the pool funded 1 exchange for 1 learner across 1 topic.',
    );
  });

  it('features branch depth and the deepest rabbit hole', () => {
    expect(poolImpactDepthText({ avgDepth: 1.4567, maxDepth: 7, deepest: null })).toBe(
      'Learners went 1.5 branches deep on average, and 7 branches at the deepest.',
    );
    expect(
      poolImpactDepthText({
        avgDepth: 1,
        maxDepth: 1,
        deepest: { id: 'history.ancient-rome', label: 'Ancient Rome', avgDepth: 2.25 },
      }),
    ).toBe(
      'Learners went 1 branch deep on average, and 1 branch at the deepest. Deepest rabbit hole: Ancient Rome (2.3 on average).',
    );
    expect(poolImpactTopicText({ label: 'Ancient Rome', learners: 40 })).toBe(
      'Ancient Rome: 40 learners',
    );
  });

  it('never words funding as a donation', () => {
    const texts = [
      poolImpactHeadline({ weekStart: '2026-09-28', exchanges: 2, learners: 2, topics: 2 }),
      poolImpactDepthText({ avgDepth: 2, maxDepth: 3, deepest: null }),
    ];
    for (const t of texts) expect(t).not.toMatch(FORBIDDEN_POOL_COPY);
  });

  it('accepts only YYYY-MM-DD weeks', () => {
    expect(poolImpactQuerySchema.parse({})).toEqual({});
    expect(poolImpactQuerySchema.parse({ week: '2026-09-28' })).toEqual({ week: '2026-09-28' });
    expect(poolImpactQuerySchema.safeParse({ week: 'last' }).success).toBe(false);
  });
});
