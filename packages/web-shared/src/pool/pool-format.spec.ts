import type { PoolBlockDetails, PoolStatusResponse } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../core/api-client';
import {
  poolBlockOf,
  poolBlockText,
  poolDollarsLabel,
  sessionsLabel,
  untilText,
  type PoolBlock,
} from './pool-format';

const STATUS: PoolStatusResponse = {
  enabled: true,
  availableMicros: 2_468_000,
  sessionsRemaining: 123,
  model: { id: 'm', label: 'Lite' },
};

describe('the pool meter', () => {
  it('reads "about N learning sessions" plus dollars', () => {
    expect(sessionsLabel(STATUS)).toBe('About 123 learning sessions');
    expect(poolDollarsLabel(STATUS)).toBe('$2.47 in the pool');
    expect(sessionsLabel({ sessionsRemaining: 0 })).toBe('No learning sessions');
  });
});

const NOW = new Date('2026-10-05T19:00:00.000Z');
const RESET = '2026-10-06T00:00:00.000Z';

function details(over: Partial<PoolBlockDetails> = {}): PoolBlockDetails {
  return {
    reason: 'cap_requests',
    limit: 30,
    resetAt: RESET,
    ...over,
  };
}

const cap = (over: Partial<PoolBlockDetails> = {}): PoolBlock => ({
  kind: 'cap',
  details: details(over),
});

describe('poolBlockOf', () => {
  it('turns 402 pool_empty and 429 pool_cap_reached into the inline states', () => {
    const empty = details({ reason: 'empty', limit: null, resetAt: null });
    expect(poolBlockOf(new ApiError(402, 'pool_empty', 'Empty', empty))).toEqual({
      kind: 'empty',
      details: empty,
    });
    expect(poolBlockOf(new ApiError(429, 'pool_cap_reached', 'Cap', details()))).toEqual(cap());
  });

  it('is null for every other error, so those keep their own handling', () => {
    expect(poolBlockOf(new ApiError(402, 'payment_required', 'x'))).toBeNull();
    expect(poolBlockOf(new ApiError(403, 'pool_unavailable', 'x'))).toBeNull();
    expect(poolBlockOf(new Error('x'))).toBeNull();
  });

  it('still shows the right state when the body carried no details', () => {
    expect(poolBlockOf(new ApiError(402, 'pool_empty', 'x'))?.details.reason).toBe('empty');
    expect(poolBlockOf(new ApiError(429, 'pool_cap_reached', 'x'))?.kind).toBe('cap');
  });
});

describe('poolBlockText', () => {
  it('empty: says so, as the normal state, not an error', () => {
    const empty: PoolBlock = { kind: 'empty', details: details({ reason: 'empty' }) };
    // Only Tangent adds credit to the pool.
    expect(poolBlockText(empty, NOW)).toEqual({
      title: 'The open pool is empty until Tangent adds more credit.',
      detail: null,
    });
  });

  it('a daily reply cap: the cap and when it resets, with no higher tier to sell', () => {
    expect(poolBlockText(cap(), NOW)).toEqual({
      title: "You've used today's 30 open-pool replies.",
      detail: 'The limit resets at 00:00 UTC (in 5 h).',
    });
  });

  it('a daily spend cap is stated in dollars', () => {
    expect(poolBlockText(cap({ reason: 'cap_spend', limit: 100_000 }), NOW)).toEqual({
      title: "You've used today's $0.10 of open-pool use.",
      detail: 'The limit resets at 00:00 UTC (in 5 h).',
    });
  });

  it('no cap notice mentions members: one set of caps for everyone', () => {
    for (const reason of ['cap_requests', 'cap_spend', 'cap_ip', 'cap_global', 'rate'] as const) {
      const t = poolBlockText(cap({ reason }), NOW);
      expect(`${t.title} ${t.detail ?? ''}`).not.toMatch(/member/i);
    }
  });

  it('the network and everyone-together ceilings read "busy today"', () => {
    for (const reason of ['cap_ip', 'cap_global'] as const)
      expect(poolBlockText(cap({ reason }), NOW)).toEqual({
        title: 'The open pool is busy today.',
        detail: 'It resets at 00:00 UTC (in 5 h).',
      });
  });

  it('the per-minute limit: try again shortly', () => {
    const t = poolBlockText(
      cap({ reason: 'rate', resetAt: '2026-10-05T19:00:40.000Z', limit: null }),
      NOW,
    );
    expect(t.detail).toBe('Try again in a minute.');
  });

  it('counts down in minutes, then hours', () => {
    expect(untilText('2026-10-05T19:30:00.000Z', NOW)).toBe('30 min');
    expect(untilText('2026-10-05T19:00:10.000Z', NOW)).toBe('a minute');
    expect(untilText(RESET, NOW)).toBe('5 h');
  });
});
