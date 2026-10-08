import '@angular/compiler'; // JIT: the component metadata below.
import { compareUsageNote, FORBIDDEN_POOL_COPY, maxUsageNote } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { CompareDialog } from './chat/compare-dialog';
import { Composer } from './chat/composer';
import { FundingToggle, FUNDING_OPTIONS } from './chat/funding-toggle';
import { ModelToggle } from './chat/model-toggle';
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

  it('says Tangent provides the pool’s credit, and never sells it', () => {
    const home = templateOf(HomePage);
    expect(home).toContain('{{ funding }} Any signed-in learner can use it');
    const dialog = templateOf(ModelAccessDialog);
    expect(dialog).toMatch(/Free credit\s+Tangent provides\./);
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

describe('Learn copy rule (Normal and Max)', () => {
  it('Max says how much more it uses than Normal, where it can be picked', () => {
    expect(maxUsageNote(3)).toBe('Max uses about 3× as much as Normal.');
    // The default tiers' prices give a two-digit factor (about 14).
    expect(maxUsageNote(14)).toBe('Max uses about 14× as much as Normal.');
    expect(maxUsageNote(undefined)).toContain('more than Normal');
    expect(templateOf(HomePage)).toContain('<p class="tier-note" role="status">{{ note }}</p>');
  });

  it('Compare says it uses both models and keeps only the answer picked', () => {
    expect(compareUsageNote(3)).toContain('Only the answer you pick is kept.');
    expect(compareUsageNote(undefined)).toContain('uses both models');
    const t = templateOf(CompareDialog);
    expect(t).toContain('heading="Compare answers"');
    expect(t).toContain('[note]="note()"');
    expect(t).toMatch(/Closing discards both answers; your question stays in the box\./);
  });

  it('on the open pool (Lite, no tier), the switch says so in visible text, not just a title', () => {
    const t = templateOf(ModelToggle);
    expect(t).toMatch(
      /@if \(unlisted\(\); as hint\) \{\s*<span class="model-locked muted small">\{\{ hint \}\}<\/span>/,
    );
  });

  it('the composer offers Compare beside Send, saying it uses both', () => {
    const t = templateOf(Composer);
    expect(t).toContain('title="Ask Normal and Max, then keep one answer (uses both)"');
    expect(t).toContain('<span class="hide-narrow">Compare</span>');
  });
});
