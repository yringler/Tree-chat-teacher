import type { CheckoutResponse, PoolStatusResponse, PurchaseTarget } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import { POOL_POLL_ATTEMPTS, PoolFundController } from './pool-fund-controller';

const STATUS: PoolStatusResponse = {
  enabled: true,
  fundingOpen: true,
  availableMicros: 2_400_000,
  sessionsRemaining: 120,
  model: { id: 'deepseek/deepseek-v4-flash', label: 'Simple' },
  week: { start: '2026-10-05T00:00:00.000Z', exchanges: 340, learners: 12 },
  markupBps: 500,
  minPurchaseCents: 1000,
};

function setup(status: PoolStatusResponse = STATUS) {
  const api = {
    poolStatus: vi.fn(async () => status),
    createCheckout: vi.fn(
      async (_cents: number, _target: PurchaseTarget): Promise<CheckoutResponse> => ({
        url: 'https://checkout.stripe.com/c/pool',
      }),
    ),
  };
  const navigate = vi.fn((_url: string) => undefined);
  const ctl = new PoolFundController({ api, navigate, sleep: async () => undefined });
  return { ctl, api, navigate };
}

describe('PoolFundController', () => {
  it('offers the presets at or above the pool minimum ($10)', async () => {
    const { ctl } = setup();
    await ctl.init(false);
    expect(ctl.presets()).toEqual([1000, 2000, 5000]);
    expect(ctl.presets().every((c) => c >= 1000)).toBe(true);
    const higher = setup({ ...STATUS, minPurchaseCents: 2000 });
    await higher.ctl.init(false);
    expect(higher.ctl.presets()).toEqual([2000, 5000]);
  });

  it('funds the pool: a checkout whose target is the pool, then off to Stripe', async () => {
    const { ctl, api, navigate } = setup();
    await ctl.init(false);
    await ctl.fund(2000);
    expect(api.createCheckout).toHaveBeenCalledWith(2000, 'pool');
    expect(navigate).toHaveBeenCalledWith('https://checkout.stripe.com/c/pool');
    // Leaving: still pending, so nothing is clicked twice.
    expect(ctl.busy()).toBe(true);
    await ctl.fund(1000);
    expect(api.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('refuses below the minimum, and while funding is not open', async () => {
    const { ctl, api } = setup();
    await ctl.init(false);
    await ctl.fund(500);
    expect(ctl.actionError()).toBe('That amount is below the pool minimum.');
    const closed = setup({ ...STATUS, fundingOpen: false });
    await closed.ctl.init(false);
    await closed.ctl.fund(1000);
    expect(api.createCheckout).not.toHaveBeenCalled();
    expect(closed.api.createCheckout).not.toHaveBeenCalled();
  });

  it('shows a checkout error and lets the buttons work again', async () => {
    const { ctl, api } = setup();
    api.createCheckout.mockRejectedValueOnce(new Error('Stripe is down'));
    await ctl.init(false);
    await ctl.fund(1000);
    expect(ctl.actionError()).toBe('Stripe is down');
    expect(ctl.busy()).toBe(false);
  });

  it('back from a paid pool checkout: waits for the meter to move, then ends "pool-funded"', async () => {
    const { ctl, api } = setup();
    api.poolStatus
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValueOnce({ ...STATUS, availableMicros: 11_659_259 });
    await ctl.init(true);
    expect(ctl.notice()).toBe('pool-funded');
    expect(ctl.status()?.availableMicros).toBe(11_659_259);
    ctl.dismissNotice();
    expect(ctl.notice()).toBeNull();
  });

  it('a balance that only drops (other learners spending) is not the purchase', async () => {
    const { ctl, api } = setup();
    api.poolStatus
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValueOnce({ ...STATUS, availableMicros: 2_390_000 })
      .mockResolvedValueOnce({ ...STATUS, availableMicros: 2_370_000 })
      .mockResolvedValue({ ...STATUS, availableMicros: 2_350_000 });
    await ctl.init(true);
    expect(ctl.notice()).toBe('slow');
    expect(ctl.status()?.availableMicros).toBe(2_350_000);
  });

  it('gives up politely ("slow") when the meter never moves', async () => {
    const { ctl, api } = setup();
    await ctl.init(true);
    expect(ctl.notice()).toBe('slow');
    expect(api.poolStatus).toHaveBeenCalledTimes(1 + POOL_POLL_ATTEMPTS);
  });
});
