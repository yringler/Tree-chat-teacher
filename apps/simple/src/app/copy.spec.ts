import { FORBIDDEN_POOL_COPY, LEARN_KEY_LABELS } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { FUNDING_OPTIONS, ownKeyOption } from './chat/switches';

/* Learn's generated copy; its templates are checked in web-shared's copy-rules.spec.ts. */

describe('Learn copy rule (open pool)', () => {
  it('the composer’s funding switch never says "donate" or "tax-deductible"', () => {
    for (const o of [...FUNDING_OPTIONS, ...Object.values(LEARN_KEY_LABELS).map(ownKeyOption)])
      expect(`${o.label} ${o.hint}`).not.toMatch(FORBIDDEN_POOL_COPY);
  });
});
