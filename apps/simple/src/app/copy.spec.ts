import '@angular/compiler'; // JIT: the component metadata below.
import { FORBIDDEN_POOL_COPY } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { FundingToggle, FUNDING_OPTIONS } from './chat/funding-toggle';
import { HomePage } from './home/home-page';
import { AppHeader } from './shell/app-header';
import { ModelAccessDialog } from './shell/model-access-dialog';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

describe('Learn copy rule (community pool)', () => {
  it('funding the pool is a credit purchase: never "donate" or "tax-deductible"', () => {
    for (const type of [AppHeader, ModelAccessDialog, HomePage, FundingToggle])
      expect(templateOf(type)).not.toMatch(FORBIDDEN_POOL_COPY);
    for (const o of FUNDING_OPTIONS)
      expect(`${o.label} ${o.hint}`).not.toMatch(FORBIDDEN_POOL_COPY);
  });

  it('offers the pool where learners choose how replies are paid for', () => {
    const t = templateOf(ModelAccessDialog);
    expect(t).toContain('Use the community pool');
    expect(t).toContain(`(change)="choose('pool')"`);
    expect(templateOf(HomePage)).toContain('<app-pool-meter [status]="status" />');
  });
});
