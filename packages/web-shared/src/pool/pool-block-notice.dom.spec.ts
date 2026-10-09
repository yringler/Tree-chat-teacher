import type { PoolBlockDetails } from '@tangent/shared';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { provideAnyRoute, render } from '../testing';
import { PoolBlockNotice } from './pool-block-notice';
import type { PoolBlock } from './pool-format';

const empty: PoolBlock = {
  kind: 'empty',
  details: { reason: 'empty', limit: null, resetAt: null },
};
const cap = (reason: PoolBlockDetails['reason'], inMs = 3_600_000): PoolBlock => ({
  kind: 'cap',
  details: { reason, limit: 30, resetAt: new Date(Date.now() + inMs).toISOString() },
});

async function notice(block: PoolBlock, creditOpen = false) {
  const r = await render(PoolBlockNotice, {
    inputs: { block, creditOpen },
    providers: [provideAnyRoute()],
  });
  const dismissed = vi.fn();
  r.component.dismissed.subscribe(dismissed);
  return { ...r, dismissed, user: userEvent.setup() };
}

const links = () =>
  screen.queryAllByRole('link').map((a) => [a.textContent?.trim(), a.getAttribute('href')]);

describe('PoolBlockNotice', () => {
  it('an empty pool: says so, offers personal credit when it is on sale, and how the pool works', async () => {
    await notice(empty, true);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('The open pool is empty until Tangent adds more credit.');
    expect(links()).toEqual([
      ['Buy personal credits', '/billing'],
      ['How the pool works', '/pool'],
    ]);
  });

  it('nothing to buy where credit is not on sale', async () => {
    await notice(empty, false);
    expect(links()).toEqual([['How the pool works', '/pool']]);
  });

  it('a daily cap: the cap, when it resets, and personal credit (it has no daily cap)', async () => {
    await notice(cap('cap_requests'), true);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain("You've used today's 30 open-pool replies.");
    expect(text).toContain('The limit resets at');
    expect(links()).toEqual([['Buy personal credits', '/billing']]);
  });

  it('the per-minute limit clears by itself: nothing to buy', async () => {
    await notice(cap('rate', 40_000), true);
    expect(screen.getByRole('status').textContent).toContain('Try again in a minute.');
    expect(links()).toEqual([]);
  });

  it('Dismiss dismisses it', async () => {
    const n = await notice(empty);
    await n.user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(n.dismissed).toHaveBeenCalledTimes(1);
  });
});
