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

  it('says who adds the pool’s credit, and offers funding only while it is open', () => {
    const card = templateOf(HomePage).split('@if (status.fundingOpen) {')[1] ?? '';
    const [open = '', rest = ''] = card.split('} @else {');
    const closed = rest.slice(0, rest.indexOf('</p>'));
    expect(open).toContain('Credit anyone can add');
    expect(open).toContain('Fund the pool');
    expect(closed).toContain('Credit Tangent adds and any signed-in learner can use');
    expect(closed).not.toContain('Fund the pool');
    expect(closed).not.toContain('anyone can add');

    const dialog = templateOf(ModelAccessDialog);
    expect(dialog).toMatch(
      /@if \(account\.poolStatus\(\)\?\.fundingOpen\) \{\s*Funded by people who add credit to it\.\s*\} @else if \(account\.poolStatus\(\)\) \{\s*Tangent adds its credit\.\s*\}/,
    );
    expect(dialog).toMatch(
      /@if \(account\.poolStatus\(\)\?\.fundingOpen\) \{\s*· <a routerLink="\/billing" fragment="fund-pool" \(click\)="close\(\)">Fund the pool<\/a>\s*\}/,
    );
  });
});
