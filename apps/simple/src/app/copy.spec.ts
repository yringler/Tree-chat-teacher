import '@angular/compiler'; // JIT: switches.ts's module imports the router, which links on load.
import { compareUsageNote, FORBIDDEN_POOL_COPY, maxUsageNote } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { FUNDING_OPTIONS, tierSwitch } from './chat/switches';

/* Learn's generated copy; its templates are checked in web-shared's copy-rules.spec.ts. */

describe('Learn copy rule (open pool)', () => {
  it('the composer’s funding switch never says "donate" or "tax-deductible"', () => {
    for (const o of FUNDING_OPTIONS)
      expect(`${o.label} ${o.hint}`).not.toMatch(FORBIDDEN_POOL_COPY);
  });
});

describe('Learn copy rule (Normal and Max)', () => {
  it('Max says how much more it uses than Normal', () => {
    expect(maxUsageNote(3)).toBe('Max uses about 3× as much as Normal.');
    // The default tiers' prices give a two-digit factor (about 14).
    expect(maxUsageNote(14)).toBe('Max uses about 14× as much as Normal.');
    expect(maxUsageNote(undefined)).toContain('more than Normal');
  });

  it('Compare says it uses both models and keeps only the answer picked', () => {
    expect(compareUsageNote(3)).toContain('Only the answer you pick is kept.');
    expect(compareUsageNote(undefined)).toContain('uses both models');
  });

  it('on the open pool (Lite, no tier), the switch says so in visible text, not just a title', () => {
    const hint = 'The open pool uses Lite.';
    const models = [{ id: 'normal/m', label: 'Normal', tier: 'normal' as const }];
    expect(tierSwitch(models, 'lite/m', hint).unlisted).toBe(hint);
    // On a listed model the hint goes with the locked switch instead.
    expect(tierSwitch(models, 'normal/m', hint)).toMatchObject({
      unlisted: null,
      lockedHint: hint,
    });
  });
});
