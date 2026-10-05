import '@angular/compiler'; // JIT: compiles the component below without the Angular CLI.
import { reflectComponentType } from '@angular/core';
import type { PoolBlockDetails } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../core/api-client';
import { PoolBlockNotice } from './pool-block-notice';
import { poolBlockOf, poolBlockText, untilText, type PoolBlock } from './pool-format';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

const NOW = new Date('2026-10-05T19:00:00.000Z');
const RESET = '2026-10-06T00:00:00.000Z';

function details(over: Partial<PoolBlockDetails> = {}): PoolBlockDetails {
  return {
    reason: 'cap_requests',
    limit: 30,
    resetAt: RESET,
    supporter: false,
    supporterLimit: 150,
    ...over,
  };
}

const cap = (over: Partial<PoolBlockDetails> = {}): PoolBlock => ({
  kind: 'cap',
  details: details(over),
});

describe('poolBlockOf', () => {
  it('turns 402 pool_empty and 429 pool_cap_reached into the inline states', () => {
    const empty = details({ reason: 'empty', limit: null, resetAt: null, supporterLimit: null });
    expect(poolBlockOf(new ApiError(402, 'pool_empty', 'Empty', empty))).toEqual({
      kind: 'empty',
      details: empty,
    });
    expect(poolBlockOf(new ApiError(429, 'pool_cap_reached', 'Cap', details()))).toEqual(cap());
  });

  it('is null for every other error, so those keep their own handling', () => {
    expect(poolBlockOf(new ApiError(402, 'payment_required', 'x'))).toBeNull();
    expect(poolBlockOf(new ApiError(403, 'pool_unavailable', 'x'))).toBeNull();
    expect(poolBlockOf(new Error('x'))).toBeNull();
  });

  it('still shows the right state when the body carried no details', () => {
    expect(poolBlockOf(new ApiError(402, 'pool_empty', 'x'))?.details.reason).toBe('empty');
    expect(poolBlockOf(new ApiError(429, 'pool_cap_reached', 'x'))?.kind).toBe('cap');
  });
});

describe('poolBlockText', () => {
  it('empty: says so, as the normal state, not an error', () => {
    expect(poolBlockText({ kind: 'empty', details: details({ reason: 'empty' }) }, NOW)).toEqual({
      title: 'The community pool is empty. It refills as people fund it.',
      detail: null,
      supporters: null,
    });
  });

  it('a daily reply cap: the cap, when it resets, and that supporters get more', () => {
    expect(poolBlockText(cap(), NOW)).toEqual({
      title: "You've used today's 30 community-pool replies.",
      detail: 'The limit resets at 00:00 UTC (in 5 h).',
      supporters: 'Supporters get 150 a day.',
    });
  });

  it('a daily spend cap is stated in dollars', () => {
    expect(
      poolBlockText(cap({ reason: 'cap_spend', limit: 100_000, supporterLimit: 500_000 }), NOW),
    ).toEqual({
      title: "You've used today's $0.10 of community-pool use.",
      detail: 'The limit resets at 00:00 UTC (in 5 h).',
      supporters: 'Supporters get $0.50 a day.',
    });
  });

  it('a supporter is not told about supporters', () => {
    expect(poolBlockText(cap({ supporter: true, limit: 150 }), NOW).supporters).toBeNull();
  });

  it('the network and everyone-together ceilings read "busy today"', () => {
    for (const reason of ['cap_ip', 'cap_global'] as const)
      expect(poolBlockText(cap({ reason, supporterLimit: null }), NOW)).toEqual({
        title: 'The community pool is busy today.',
        detail: 'It resets at 00:00 UTC (in 5 h).',
        supporters: null,
      });
  });

  it('the per-minute limit: try again shortly', () => {
    const t = poolBlockText(
      cap({ reason: 'rate', resetAt: '2026-10-05T19:00:40.000Z', limit: null }),
      NOW,
    );
    expect(t.detail).toBe('Try again in a minute.');
  });

  it('counts down in minutes, then hours', () => {
    expect(untilText('2026-10-05T19:30:00.000Z', NOW)).toBe('30 min');
    expect(untilText('2026-10-05T19:00:10.000Z', NOW)).toBe('a minute');
    expect(untilText(RESET, NOW)).toBe('5 h');
  });
});

describe('PoolBlockNotice', () => {
  it('is <app-pool-block-notice>', () => {
    expect(reflectComponentType(PoolBlockNotice)?.selector).toBe('app-pool-block-notice');
  });

  it('shows the state inline with Fund the pool and Buy personal credits', () => {
    const t = templateOf(PoolBlockNotice);
    expect(t).toContain('role="status"');
    expect(t).toContain('{{ text().title }}');
    expect(t).toContain('{{ supporters }}');
    expect(t).toContain(
      '<a class="btn btn-primary btn-sm" [routerLink]="billingPath()" fragment="fund-pool"\n                >Fund the pool</a\n              >',
    );
    expect(t).toContain('<a class="btn btn-sm" [routerLink]="billingPath()">Buy personal credits</a>');
    // Before funding opens, both lead to the page that explains the pool.
    expect(t).toContain('<a class="btn btn-primary btn-sm" href="/pool">Fund the pool</a>');
    expect(t).toContain('<a class="btn btn-sm" href="/pool">Buy personal credits</a>');
    expect(t).toContain('aria-label="Dismiss"');
  });
});
