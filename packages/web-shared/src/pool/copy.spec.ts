import { FORBIDDEN_POOL_COPY, POOL_FUNDING_TEXT, type PoolBlockDetails } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { poolBlockText, sessionsLabel } from './pool-format';

const REASONS: PoolBlockDetails['reason'][] = [
  'empty',
  'unpriced',
  'cap_requests',
  'cap_spend',
  'cap_ip',
  'cap_global',
  'rate',
];

describe('pool copy rule', () => {
  // Templates: copy-rules.spec.ts.
  it('never says donate, donation or tax-deductible in generated text', () => {
    const texts = [POOL_FUNDING_TEXT, sessionsLabel({ sessionsRemaining: 3 })];
    for (const reason of REASONS) {
      const t = poolBlockText({
        kind: reason === 'empty' || reason === 'unpriced' ? 'empty' : 'cap',
        details: {
          reason,
          limit: 30,
          resetAt: '2026-10-06T00:00:00.000Z',
        },
      });
      texts.push(t.title, t.detail ?? '');
    }
    for (const text of texts) expect(text).not.toMatch(FORBIDDEN_POOL_COPY);
  });
});
