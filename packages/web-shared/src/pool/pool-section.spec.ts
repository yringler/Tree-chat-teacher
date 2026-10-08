import '@angular/compiler'; // JIT: compiles the components below without the Angular CLI.
import { reflectComponentType } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { BillingPage } from '../billing/billing-page';
import { PoolMeter } from './pool-meter';
import { PoolSection } from './pool-section';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

describe('PoolSection', () => {
  const t = templateOf(PoolSection);

  it('is <app-pool-section>, on the billing page of both apps', () => {
    expect(reflectComponentType(PoolSection)?.selector).toBe('app-pool-section');
    expect(templateOf(BillingPage)).toContain('<app-pool-section />');
  });

  it('renders only while the pool is on, with the meter, the funding text and the link', () => {
    expect(t).toContain('@if (s.enabled) {');
    expect(t).toContain('<app-pool-meter [status]="s" />');
    expect(t).toContain('{{ funding(s) }}');
    expect(t).toContain('<a href="/pool" target="_blank" rel="noopener">');
  });

  it('offers nothing to buy: nobody buys pool credit', () => {
    expect(t).not.toMatch(/fund the|checkout|presets|buy|purchase|fund-pool/i);
  });
});

describe('PoolMeter', () => {
  it('shows about N learning sessions and the dollars', () => {
    expect(reflectComponentType(PoolMeter)?.selector).toBe('app-pool-meter');
    const t = templateOf(PoolMeter);
    expect(t).toContain('{{ headline() }}');
    expect(t).toContain('{{ dollars() }}');
  });
});
