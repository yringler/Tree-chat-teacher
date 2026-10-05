import '@angular/compiler'; // JIT: compiles the components below without the Angular CLI.
import { reflectComponentType } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { BillingPage } from '../billing/billing-page';
import { PoolFundSection } from './pool-fund-section';
import { PoolMeter } from './pool-meter';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

describe('PoolFundSection', () => {
  const t = templateOf(PoolFundSection);

  it('is <app-pool-fund-section>, on the billing page of both apps', () => {
    expect(reflectComponentType(PoolFundSection)?.selector).toBe('app-pool-fund-section');
    expect(templateOf(BillingPage)).toContain('<app-pool-fund-section [funded]="poolFunded" />');
  });

  it('renders only while the pool is on, at #fund-pool, with the meter', () => {
    expect(t).toContain('@if (s.enabled) {');
    expect(t).toContain('id="fund-pool"');
    expect(t).toContain('Fund the community pool');
    expect(t).toContain('<app-pool-meter [status]="s" />');
  });

  it('offers the presets, with the one-line fee disclosure and the transparency link', () => {
    expect(t).toContain('@for (cents of ctl.presets(); track cents)');
    expect(t).toContain('(click)="ctl.fund(cents)"');
    expect(t).toContain('{{ note(s) }} Prices exclude tax; tax is calculated at checkout.');
    expect(t).toContain('<a href="/pool" target="_blank" rel="noopener">');
  });

  it('funding closed: a disabled "Funding opens soon"; the meter and the link still show', () => {
    expect(t).toMatch(
      /\} @else \{\s*<div class="billing-actions">\s*<button type="button" class="btn" disabled>Funding opens soon<\/button>/,
    );
    const closed = t.slice(t.indexOf('Funding opens soon'));
    expect(closed).toContain('href="/pool"');
    expect(t.indexOf('<app-pool-meter')).toBeLessThan(t.indexOf('@if (demo)'));
  });

  it('thanks the buyer when the pool was funded', () => {
    expect(t).toContain("@case ('pool-funded')");
    expect(t).toContain('Thanks! Your credit is in the community pool.');
  });
});

describe('PoolMeter', () => {
  it('shows about N learning sessions, the dollars and this week', () => {
    expect(reflectComponentType(PoolMeter)?.selector).toBe('app-pool-meter');
    const t = templateOf(PoolMeter);
    expect(t).toContain('{{ headline() }}');
    expect(t).toContain('{{ dollars() }}');
    expect(t).toContain('{{ week() }}');
  });
});
