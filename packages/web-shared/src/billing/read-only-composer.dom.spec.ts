import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { membership, render } from '../testing';
import { ReadOnlyComposer } from './read-only-composer';

async function notice(inputs: Record<string, unknown> = {}) {
  const r = await render(ReadOnlyComposer, {
    inputs: {
      membership: membership({ status: 'inactive', subscriptionStatus: 'canceled' }),
      treeId: 't1',
      ...inputs,
    },
  });
  const useCredit = vi.fn();
  r.component.useCredit.subscribe(useCredit);
  return { ...r, useCredit, user: userEvent.setup() };
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

  it('links to the same conversation and branch in Learn where Learn can reply', async () => {
    await notice({ learn: 'pool', branchId: 'b1' });
    expect(screen.getByRole('link', { name: 'Open in Learn' }).getAttribute('href')).toBe(
      '/learn/t/t1/b/b1',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers Tangent credit where it is sold, and hands the switch to the app', async () => {
    const n = await notice({ credit: true });
    await n.user.click(screen.getByRole('button', { name: 'Continue with Tangent credit' }));
    expect(n.useCredit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: 'Open in Learn' })).toBeNull();
  });
});
