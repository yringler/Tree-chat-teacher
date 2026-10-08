import type { PoolStatusResponse } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { poolDollarsLabel, sessionsLabel } from './pool-format';

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
