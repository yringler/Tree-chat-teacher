import type { PoolStatusResponse } from '@tangent/shared';
import { POOL_FUNDING_TEXT } from '@tangent/shared';
import { screen, within } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { BillingPage } from '../billing/billing-page';
import { ApiClient } from '../core/api-client';
import { BillingClient } from '../core/billing-client';
import { DEMO_MODE } from '../core/demo';
import { billing, provideAnyRoute, render } from '../testing';
import { PoolSection } from './pool-section';

const ON: PoolStatusResponse = {
  enabled: true,
  availableMicros: 2_000_000,
  sessionsRemaining: 10,
  model: { id: 'lite', label: 'Lite' },
};

function api(status: PoolStatusResponse | Error) {
  return {
    poolStatus: vi.fn(async () => {
      if (status instanceof Error) throw status;
      return status;
    }),
    billing: vi.fn(async () => billing()),
    usage: vi.fn(async () => ({ entries: [] })),
  };
}

describe('PoolSection', () => {
  it('while the pool is on: the meter, who provides it, and how it works; nothing to buy', async () => {
    await render(PoolSection, { providers: [{ provide: ApiClient, useValue: api(ON) }] });
    const section = await screen.findByRole('region', { name: 'The open pool' });
    const meter = within(section).getByRole('group', { name: 'Open pool' });
    expect(meter.textContent).toContain('left');
    expect(meter.textContent).toContain('$2.00 in the pool');
    expect(section.textContent).toContain(POOL_FUNDING_TEXT);
    expect(section.textContent).toContain('Any signed-in learner can use it on Lite');
    const how = within(section).getByRole('link', { name: /How the pool works/ });
    expect([how.getAttribute('href'), how.getAttribute('target')]).toEqual(['/pool', '_blank']);
    expect(within(section).queryAllByRole('button')).toEqual([]);
    expect(within(section).queryAllByRole('link')).toHaveLength(1);
  });

  it.each([
    ['off', { ...ON, enabled: false }],
    ['unreadable', new Error('Network error')],
  ])('shows nothing while the pool is %s', async (_, status) => {
    const r = await render(PoolSection, {
      providers: [{ provide: ApiClient, useValue: api(status) }],
    });
    await r.fixture.whenStable();
    expect(r.host.textContent?.trim()).toBe('');
  });

  it('is on the billing page', async () => {
    const stub = api(ON);
    await render(BillingPage, {
      providers: [
        { provide: ApiClient, useValue: stub },
        { provide: BillingClient, useValue: {} },
        { provide: DEMO_MODE, useValue: false },
        provideAnyRoute(),
      ],
    });
    await screen.findByRole('region', { name: 'The open pool' });
    expect(stub.poolStatus).toHaveBeenCalledTimes(1);
  });
});
