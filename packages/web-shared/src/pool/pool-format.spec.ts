import type { PoolStatusResponse } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { poolDollarsLabel, poolWeekLabel, sessionsLabel } from './pool-format';

const STATUS: PoolStatusResponse = {
  enabled: true,
  availableMicros: 2_468_000,
  sessionsRemaining: 123,
  model: { id: 'm', label: 'Simple' },
  week: { start: '2026-10-05T00:00:00.000Z', exchanges: 1240, learners: 87 },
  revenueShareBps: 2000,
};

describe('the pool meter', () => {
  it('reads "about N learning sessions" plus dollars', () => {
    expect(sessionsLabel(STATUS)).toBe('About 123 learning sessions');
    expect(poolDollarsLabel(STATUS)).toBe('$2.47 in the pool');
    expect(sessionsLabel({ sessionsRemaining: 0 })).toBe('No learning sessions');
  });

  it('counts this week in aggregate only', () => {
    expect(poolWeekLabel(STATUS)).toBe('This week: 87 learners, 1,240 free replies');
    expect(poolWeekLabel({ week: { ...STATUS.week, learners: 1, exchanges: 1 } })).toBe(
      'This week: 1 learner, 1 free reply',
    );
  });
});
