import '@angular/compiler'; // JIT: compiles the components below without the Angular CLI.
import { reflectComponentType } from '@angular/core';
import type { AdminPoolTopic } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { App } from './app';
import { afterDecision, PoolTopicsPage } from './pool-topics-page';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

function topic(id: string, status: AdminPoolTopic['status']): AdminPoolTopic {
  return {
    id,
    label: id,
    group: 'History',
    status,
    firstSeenWeek: '2026-09-28',
    decidedAt: null,
    decidedBy: null,
    blocklisted: false,
  };
}

describe('PoolTopicsPage (the impact feed review queue)', () => {
  const t = templateOf(PoolTopicsPage);

  it('is on the admin page', () => {
    expect(reflectComponentType(PoolTopicsPage)?.selector).toBe('app-pool-topics-page');
    expect(templateOf(App)).toContain('<app-pool-topics-page />');
  });

  it('lists the queue with Approve and Reject, and flags blocklisted topics', () => {
    expect(t).toContain('@for (t of topics(); track t.id)');
    expect(t).toContain(`(click)="decide(t, 'approved')"`);
    expect(t).toContain(`(click)="decide(t, 'rejected')"`);
    expect(t).toContain('@if (t.blocklisted)');
    expect(t).toContain('Approval applies from the next weekly snapshot.');
  });

  it('a decided topic leaves the list it no longer belongs to', () => {
    const list = [topic('a', 'pending'), topic('b', 'pending')];
    expect(afterDecision(list, 'pending', topic('a', 'approved')).map((x) => x.id)).toEqual(['b']);
    const approved = [topic('a', 'approved')];
    const again = { ...topic('a', 'approved'), decidedBy: 'admin' };
    expect(afterDecision(approved, 'approved', again)).toEqual([again]);
  });

  it('never offers featured conversations (the wall is a stub)', () => {
    for (const type of [App, PoolTopicsPage]) expect(templateOf(type)).not.toMatch(/featur/i);
  });
});
