import { TestBed } from '@angular/core/testing';
import { BillingClient } from '@tangent/web-shared';
import { appProviders, billing, deferred, membership, render } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { learner, NOT_A_MEMBER, POOL_ON } from '../learn.testing';
import { LearnFunding } from '../state/learn-funding';
import { KeyLockedNotice } from './key-locked-notice';

/** The notice for a learner whose own key needs the membership they lack, and `facts`. */
async function notice(facts: Parameters<typeof learner>[0] = {}) {
  const checkout = deferred<undefined>();
  const upgrade = vi.fn(() => checkout.promise);
  const r = await render(KeyLockedNotice, {
    providers: [...appProviders({}), { provide: BillingClient, useValue: { upgrade } }],
    setup: () => {
      learner({ membership: NOT_A_MEMBER, chosen: 'own-key', ...facts });
    },
  });
  const funding = TestBed.inject(LearnFunding);
  return { ...r, checkout, upgrade, funding, user: userEvent.setup() };
}

/** The notice's buttons and links, in order. */
const actions = () =>
  [...screen.getByRole('region').querySelectorAll('button, a')].map((a) => a.textContent?.trim());

describe('KeyLockedNotice', () => {
  it('a learner who never had a membership: become a member, or carry on on the pool or credit', async () => {
    await notice({ pool: POOL_ON, billing: billing({ availableMicros: 500_000 }) });
    const region = screen.getByRole('region', {
      name: 'Replies on your own key need a membership.',
    });
    expect(region.textContent).toContain(
      'The membership is $10 a year; OpenRouter still bills you for the replies. Or carry on without one:',
    );
    expect(actions()).toEqual([
      'Become a member',
      'Continue on the open pool',
      'Continue on Tangent credit',
      'See billing',
    ]);
  });

  it('each way out switches how replies are paid for, in one click', async () => {
    const n = await notice({ pool: POOL_ON, billing: billing({ availableMicros: 500_000 }) });
    const switchTo = vi.spyOn(n.funding, 'switchTo');
    await n.user.click(screen.getByRole('button', { name: 'Continue on Tangent credit' }));
    expect(switchTo).toHaveBeenLastCalledWith('credit');
    expect(n.funding.membershipBlocked()).toBe(false);
  });

  it('the open pool too', async () => {
    const n = await notice({ pool: POOL_ON });
    const switchTo = vi.spyOn(n.funding, 'switchTo');
    await n.user.click(screen.getByRole('button', { name: 'Continue on the open pool' }));
    expect(switchTo).toHaveBeenCalledWith('pool');
  });

  it('with no credit left while the pool is on, credit is bought first, never the pool unasked', async () => {
    await notice({ pool: POOL_ON, billing: billing() });
    expect(screen.queryByRole('button', { name: 'Continue on Tangent credit' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Add Tangent credit' }).getAttribute('href')).toBe(
      '/billing',
    );
  });

  it('subscribing opens the checkout, and says why it could not', async () => {
    const n = await notice();
    const subscribe = screen.getByRole<HTMLButtonElement>('button', { name: 'Become a member' });
    await n.user.click(subscribe);
    expect(n.upgrade).toHaveBeenCalledTimes(1);
    expect(subscribe.textContent?.trim()).toBe('Opening…');
    expect(subscribe.disabled).toBe(true);
    n.checkout.reject(new Error('Checkout is unavailable'));
    await vi.waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Checkout is unavailable'),
    );
    expect(subscribe.disabled).toBe(false);
  });

  it('a lapsed member with nowhere else to go is asked to renew, and nothing more', async () => {
    await notice({
      membership: membership({ status: 'inactive', subscriptionStatus: 'canceled' }),
    });
    const region = screen.getByRole('region', { name: 'Your membership has ended.' });
    expect(region.textContent).not.toContain('carry on');
    expect(actions()).toEqual(['Renew membership', 'See billing']);
  });
});
