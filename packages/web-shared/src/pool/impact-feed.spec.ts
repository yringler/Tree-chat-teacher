import '@angular/compiler'; // JIT: compiles the component below without the Angular CLI.
import { reflectComponentType } from '@angular/core';
import type { PoolImpactResponse } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../core/api-client';
import { ImpactFeed, loadLatestImpact } from './impact-feed';
import { PoolFundSection } from './pool-fund-section';

function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

const IMPACT: PoolImpactResponse = {
  weekStart: '2026-09-28',
  exchanges: 1240,
  learners: 87,
  topics: 31,
  avgDepth: 1.4,
  maxDepth: 7,
  deepest: { id: 'history.ancient-rome', label: 'Ancient Rome', avgDepth: 2.5 },
  named: [
    {
      id: 'history.ancient-rome',
      label: 'Ancient Rome',
      learners: 40,
      exchanges: 300,
      avgDepth: 2.5,
    },
  ],
};

describe('ImpactFeed', () => {
  const t = templateOf(ImpactFeed);

  it('is <app-impact-feed>, under the meter in the fund section', () => {
    expect(reflectComponentType(ImpactFeed)?.selector).toBe('app-impact-feed');
    const section = templateOf(PoolFundSection);
    expect(section).toContain('<app-impact-feed />');
    expect(section.indexOf('<app-pool-meter')).toBeLessThan(section.indexOf('<app-impact-feed'));
  });

  it('renders only once a snapshot exists: headline, depth, named topics and past weeks', () => {
    expect(t).toMatch(/^\s*@if \(impact\(\); as i\) \{/);
    expect(t).toContain('{{ headline(i) }}');
    expect(t).toContain('{{ depth(i) }}');
    expect(t).toContain('@for (t of i.named; track t.id)');
    expect(t).toContain('{{ topic(t) }}');
    expect(t).toContain('<a href="/pool#impact" target="_blank" rel="noopener">');
  });
});

describe('loadLatestImpact', () => {
  it('resolves the latest snapshot', async () => {
    await expect(loadLatestImpact({ poolImpact: () => Promise.resolve(IMPACT) })).resolves.toBe(
      IMPACT,
    );
  });

  it('is null before the first snapshot (404), and throws anything else', async () => {
    const notFound = new ApiError(404, 'not_found', 'Impact snapshot not found');
    await expect(loadLatestImpact({ poolImpact: () => Promise.reject(notFound) })).resolves.toBe(
      null,
    );
    const down = new ApiError(500, 'internal', 'Down');
    await expect(loadLatestImpact({ poolImpact: () => Promise.reject(down) })).rejects.toBe(down);
  });
});
