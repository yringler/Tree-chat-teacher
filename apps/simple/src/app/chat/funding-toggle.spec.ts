import '@angular/compiler'; // JIT: compiles the component below without the Angular CLI.
import { reflectComponentType } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { FUNDING_OPTIONS, FundingToggle } from './funding-toggle';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

describe('FundingToggle', () => {
  it('is a radiogroup of my credit and the community pool', () => {
    expect(reflectComponentType(FundingToggle)?.selector).toBe('app-funding-toggle');
    const t = templateOf(FundingToggle);
    expect(t).toContain('role="radiogroup" aria-label="Pay for replies with"');
    expect(t).toContain('role="radio"');
    expect(t).toContain('[attr.aria-checked]="o.id === value()"');
    // Clicking the selected option emits nothing; any other emits its id.
    expect(t).toContain('(click)="o.id !== value() && changed.emit(o.id)"');
    expect(FUNDING_OPTIONS.map((o) => [o.id, o.label])).toEqual([
      ['credit', 'My credit'],
      ['pool', 'Community pool'],
    ]);
  });
});
