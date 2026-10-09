import type { CopyToLearnResponse } from '@tangent/shared';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../core/api-client';
import { LEAVE_PAGE } from '../core/leave-page';
import { deferred, membership, render } from '../testing';
import { ReadOnlyComposer } from './read-only-composer';

async function notice(inputs: Record<string, unknown> = {}) {
  const copy = deferred<CopyToLearnResponse>();
  const api = { copyToLearn: vi.fn((_treeId: string) => copy.promise) };
  const leave = vi.fn();
  const r = await render(ReadOnlyComposer, {
    inputs: {
      membership: membership({ status: 'inactive', subscriptionStatus: 'canceled' }),
      treeId: 't1',
      ...inputs,
    },
    providers: [
      { provide: ApiClient, useValue: api },
      { provide: LEAVE_PAGE, useValue: leave },
    ],
  });
  const useCredit = vi.fn();
  r.component.useCredit.subscribe(useCredit);
  return { ...r, api, copy, leave, useCredit, user: userEvent.setup() };
}

describe('ReadOnlyComposer', () => {
  it('explains, and links to the billing page to renew; nothing here sends', async () => {
    await notice({ billingHref: '/billing?from=power' });
    const region = screen.getByRole('region', { name: 'Your membership has ended.' });
    expect(region.textContent).toContain('Renew your membership to continue this conversation.');
    expect(screen.getByRole('link', { name: 'Renew membership' }).getAttribute('href')).toBe(
      '/billing?from=power',
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('copies the conversation into Learn, then leaves for the lesson', async () => {
    const n = await notice({ learn: 'pool' });
    const copy = screen.getByRole<HTMLButtonElement>('button', { name: 'Create a copy in Learn' });
    await n.user.click(copy);
    expect(n.api.copyToLearn).toHaveBeenCalledWith('t1');
    await n.fixture.whenStable();
    expect(copy.textContent?.trim()).toBe('Copying…');
    expect(copy.disabled).toBe(true);
    n.copy.resolve({ treeId: 'l1', title: 'Primes' });
    await vi.waitFor(() => expect(n.leave).toHaveBeenCalledWith('/learn/t/l1'));
  });

  it('says why a copy failed, and lets the user try again', async () => {
    const n = await notice({ learn: 'credit' });
    await n.user.click(screen.getByRole('button', { name: 'Create a copy in Learn' }));
    n.copy.reject(new ApiError(404, 'not_found', 'Tree not found'));
    await vi.waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        "Couldn't copy it to Learn: Tree not found",
      ),
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Create a copy in Learn' }).disabled,
    ).toBe(false);
    expect(n.leave).not.toHaveBeenCalled();
  });

  it('offers Tangent credit where it is sold, and hands the switch to the app', async () => {
    const n = await notice({ credit: true });
    await n.user.click(screen.getByRole('button', { name: 'Continue with Tangent credit' }));
    expect(n.useCredit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Create a copy in Learn' })).toBeNull();
  });
});
