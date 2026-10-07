import '@angular/compiler'; // JIT: the component metadata below.
import { FORBIDDEN_POOL_COPY } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { FundingToggle, FUNDING_OPTIONS } from './chat/funding-toggle';
import { HomePage } from './home/home-page';
import { AppHeader } from './shell/app-header';
import { ModelAccessDialog } from './shell/model-access-dialog';
import { PaidBy } from './shell/paid-by';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

describe('Learn copy rule (open pool)', () => {
  it('funding the pool is a credit purchase: never "donate" or "tax-deductible"', () => {
    for (const type of [AppHeader, ModelAccessDialog, HomePage, FundingToggle, PaidBy])
      expect(templateOf(type)).not.toMatch(FORBIDDEN_POOL_COPY);
    for (const o of FUNDING_OPTIONS)
      expect(`${o.label} ${o.hint}`).not.toMatch(FORBIDDEN_POOL_COPY);
  });

  it('offers the pool where learners choose how replies are paid for', () => {
    const t = templateOf(ModelAccessDialog);
    expect(t).toContain('Use the open pool');
    expect(t).toContain(`(change)="choose('pool')"`);
    expect(templateOf(HomePage)).toContain('<app-pool-meter [status]="status" />');
  });

  it('says Tangent provides the pool’s credit from its revenue, and never sells it', () => {
    const home = templateOf(HomePage);
    expect(home).toContain('{{ funding(status) }} Any signed-in learner can use it');
    const dialog = templateOf(ModelAccessDialog);
    expect(dialog).toMatch(/Free credit\s+Tangent provides from its revenue\./);
    for (const t of [home, dialog]) {
      expect(t).not.toContain('fund-pool');
      expect(t).not.toMatch(/fund the pool|funded by people|anyone can add/i);
    }
  });
});

describe('Learn copy rule (membership)', () => {
  it('the own key needs a membership where one is required: a non-member sees it disabled', () => {
    const t = templateOf(ModelAccessDialog);
    expect(t).toContain('[disabled]="ownKeyLocked()"');
    expect(t).toMatch(
      /Needs a membership \(\{\{ price\(\) \}\}\/year\): covers Tangent while OpenRouter bills you\s+directly\./,
    );
  });

  it('credit has no member conditions: anyone can buy it', () => {
    const t = templateOf(ModelAccessDialog);
    expect(t).toContain('<a routerLink="/billing" (click)="close()">Add credit</a>');
    expect(t).not.toMatch(/Members only|Buying more credit|to add more|to buy prepaid/);
  });
});
