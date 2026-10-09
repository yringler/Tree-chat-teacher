import '@angular/compiler'; // JIT: the notice's module imports the router, which links on load.
import { describe, expect, it } from 'vitest';
import { keyLockedText } from './key-locked-notice';

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
