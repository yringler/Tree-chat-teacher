import { describe, expect, it } from 'vitest';
import { POOL_BLOCK_REASONS, poolBlockDetailsSchema, poolErrorCode } from './pool.js';

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
