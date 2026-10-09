import '@angular/compiler'; // JIT: compiles the component below without the Angular CLI.
import { reflectComponentType } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { KeyLockedNotice, keyLockedText } from './key-locked-notice';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

describe('keyLockedText', () => {
  it('asks a learner who never had a membership to become a member', () => {
    expect(keyLockedText({ subscriptionStatus: null, priceCents: 1000 }, true)).toEqual({
      lead: 'Replies on your own key need a membership.',
      body: 'The membership is $10 a year; OpenRouter still bills you for the replies. Or carry on without one:',
      subscribe: 'Become a member',
    });
  });

  it('asks a lapsed member to renew, and offers no "carry on" with nowhere to go', () => {
    expect(keyLockedText({ subscriptionStatus: 'canceled', priceCents: 1000 }, false)).toEqual({
      lead: 'Your membership has ended.',
      body: 'The membership is $10 a year; OpenRouter still bills you for the replies.',
      subscribe: 'Renew membership',
    });
  });
});

describe('KeyLockedNotice', () => {
  it('offers subscribing, the open pool and Tangent credit as one-click ways out', () => {
    expect(reflectComponentType(KeyLockedNotice)?.selector).toBe('app-key-locked-notice');
    const t = templateOf(KeyLockedNotice);
    expect(t).toContain('(click)="sub.subscribe()"');
    expect(t).toContain('@if (funding.keyLockedWays().pool) {');
    expect(t).toContain(`(click)="funding.switchTo('pool')"`);
    expect(t).toContain('@if (funding.keyLockedWays().credit) {');
    expect(t).toContain(`(click)="funding.switchTo('credit')"`);
    expect(t).toContain('routerLink="/billing"');
  });
});
