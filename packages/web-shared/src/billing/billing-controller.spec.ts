import type { BillingSummary, UsageEntry, UsageListResponse } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  BillingController,
  POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
  USAGE_PAGE_SIZE,
} from './billing-controller';

function summary(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    enabled: true,
    membership: {
      required: true,
      status: 'inactive',
      stripeStatus: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      priceCents: 1000,
      includedCreditCents: 200,
    },
    builtInCredit: true,
    currency: 'usd',
    balanceMicros: 1_000_000,
    heldMicros: 0,
    availableMicros: 1_000_000,
    markupBps: 1000,
    openRouterFeeBps: 550,
    minTopUpCents: 500,
    maxTopUpCents: 50_000,
    ...overrides,
  };
}

function entry(id: string): UsageEntry {
  return {
    id,
    createdAt: '2026-09-30T12:00:00.000Z',
    purpose: 'reply',
    model: 'deepseek/deepseek-v4-flash',
    treeId: 't1',
    status: 'settled',
    chargeMicros: 420,
    inputTokens: 100,
    outputTokens: 50,
    webSearches: 0,
  };
}

/** A fake world: `billing()` returns `summaries` in order, then repeats the last one. */
function setup(summaries: BillingSummary[] = [summary()], billingPath = '/learn/billing') {
  let calls = 0;
  const api = {
    billing: vi.fn(async () => {
      const s = summaries[Math.min(calls, summaries.length - 1)]!;
      calls++;
      return s;
    }),
    usage: vi.fn(async (_cursor?: string | null, _limit?: number): Promise<UsageListResponse> => ({
      entries: [entry('u1')],
      nextCursor: null,
    })),
    createCheckout: vi.fn(async (amountCents: number) => ({
      url: `https://checkout.stripe.com/c/${amountCents}`,
    })),
  };
  const billing = {
    upgrade: vi.fn(async (..._args: unknown[]) => undefined),
    portal: vi.fn(async (_returnPath: string) => undefined),
  };
  const navigate = vi.fn((_url: string) => undefined);
  const clearCheckoutParam = vi.fn(() => undefined);
  const sleep = vi.fn(async (_ms: number) => undefined);
  const ctl = new BillingController({
    api,
    billing,
    navigate,
    clearCheckoutParam,
    sleep,
    billingPath: () => billingPath,
  });
  return { ctl, api, billing, navigate, clearCheckoutParam, sleep };
}

describe('BillingController: loading', () => {
  it('loads the summary and the first usage page', async () => {
    const { ctl, api } = setup();
    await ctl.init(null);
    await vi.waitFor(() => expect(ctl.usageLoaded()).toBe(true));
    expect(ctl.summary()?.balanceMicros).toBe(1_000_000);
    expect(api.usage).toHaveBeenCalledWith(null, USAGE_PAGE_SIZE);
    expect(ctl.usage().map((u) => u.id)).toEqual(['u1']);
    expect(ctl.notice()).toBeNull();
  });

  it('skips usage when billing is not set up', async () => {
    const { ctl, api } = setup([summary({ enabled: false })]);
    await ctl.init(undefined);
    expect(ctl.summary()?.enabled).toBe(false);
    expect(api.usage).not.toHaveBeenCalled();
  });

  it('shows a load error', async () => {
    const { ctl, api } = setup();
    api.billing.mockRejectedValueOnce(new Error('Network down'));
    await ctl.init(null);
    expect(ctl.summary()).toBeNull();
    expect(ctl.loadError()).toBe('Network down');
    await ctl.load();
    expect(ctl.loadError()).toBeNull();
    expect(ctl.summary()).not.toBeNull();
  });

  it('"Load more" appends the next page until there is no cursor', async () => {
    const { ctl, api } = setup();
    api.usage
      .mockResolvedValueOnce({ entries: [entry('a'), entry('b')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ entries: [entry('c')], nextCursor: null });
    await ctl.loadUsage(true);
    expect(ctl.usageCursor()).toBe('c1');
    await ctl.loadUsage();
    expect(api.usage).toHaveBeenLastCalledWith('c1', USAGE_PAGE_SIZE);
    expect(ctl.usage().map((u) => u.id)).toEqual(['a', 'b', 'c']);
    expect(ctl.usageCursor()).toBeNull();
    await ctl.loadUsage();
    expect(api.usage).toHaveBeenCalledTimes(2);
  });
});

describe('BillingController: ?checkout=success', () => {
  it('polls every 2 s until the balance changes, then clears the query param', async () => {
    const before = summary({ balanceMicros: 1_000_000 });
    const after = summary({ balanceMicros: 11_000_000, availableMicros: 11_000_000 });
    const { ctl, api, sleep, clearCheckoutParam } = setup([before, before, before, after]);

    const done = ctl.init('success');
    expect(ctl.notice()).toBe('waiting');
    await done;

    // One initial load, then three polls (the third sees the new balance).
    expect(api.billing).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(POLL_INTERVAL_MS);
    expect(ctl.summary()?.balanceMicros).toBe(11_000_000);
    expect(ctl.notice()).toBe('credited');
    expect(clearCheckoutParam).toHaveBeenCalledTimes(1);
  });

  it('stops when the membership becomes active, which wins over the included credit', async () => {
    const before = summary();
    const after = summary({
      balanceMicros: 3_000_000,
      membership: { ...before.membership, status: 'active' },
    });
    const { ctl, api } = setup([before, after]);
    await ctl.init('success');
    expect(api.billing).toHaveBeenCalledTimes(2);
    expect(ctl.notice()).toBe('activated');
  });

  it('gives up after 10 polls and says the credit is on its way', async () => {
    const { ctl, api, sleep, clearCheckoutParam } = setup([summary()]);
    await ctl.init('success');
    expect(sleep).toHaveBeenCalledTimes(POLL_ATTEMPTS);
    expect(api.billing).toHaveBeenCalledTimes(1 + POLL_ATTEMPTS);
    expect(ctl.notice()).toBe('slow');
    expect(clearCheckoutParam).toHaveBeenCalledTimes(1);
  });

  it('keeps polling through a failed request', async () => {
    const before = summary();
    const after = summary({ balanceMicros: 6_000_000 });
    const { ctl, api } = setup([before, before, after]);
    let n = 0;
    const real = api.billing.getMockImplementation()!;
    api.billing.mockImplementation(async () => {
      if (++n === 2) throw new Error('blip');
      return real();
    });
    await ctl.init('success');
    expect(ctl.notice()).toBe('credited');
    expect(ctl.summary()?.balanceMicros).toBe(6_000_000);
  });

  it('stops polling when the page is destroyed', async () => {
    const { ctl, api, sleep } = setup([summary()]);
    sleep.mockImplementation(async () => {
      if (sleep.mock.calls.length === 2) ctl.destroy();
    });
    await ctl.init('success');
    expect(api.billing).toHaveBeenCalledTimes(2);
    expect(ctl.notice()).toBe('waiting');
  });

  it('stops polling when the notice is dismissed', async () => {
    const { ctl, api, sleep } = setup([summary()]);
    sleep.mockImplementation(async () => {
      if (sleep.mock.calls.length === 3) ctl.dismissNotice();
    });
    await ctl.init('success');
    expect(api.billing).toHaveBeenCalledTimes(3);
    expect(ctl.notice()).toBeNull();
  });
});

describe('BillingController: ?checkout=cancel', () => {
  it('shows a dismissible notice and clears the param without polling', async () => {
    const { ctl, api, sleep, clearCheckoutParam } = setup();
    await ctl.init('cancel');
    expect(ctl.notice()).toBe('cancelled');
    expect(clearCheckoutParam).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(api.billing).toHaveBeenCalledTimes(1);
    ctl.dismissNotice();
    expect(ctl.notice()).toBeNull();
  });
});

describe('BillingController: top-ups', () => {
  it('a preset opens Checkout for that many cents', async () => {
    const { ctl, api, navigate } = setup();
    await ctl.load();
    expect(ctl.presets()).toEqual([500, 1000, 2000, 5000]);
    await ctl.topUp(2000);
    expect(api.createCheckout).toHaveBeenCalledWith(2000);
    expect(navigate).toHaveBeenCalledWith('https://checkout.stripe.com/c/2000');
    // The page is leaving: everything stays disabled.
    expect(ctl.busy()).toBe(true);
    await ctl.topUp(500);
    expect(api.createCheckout).toHaveBeenCalledTimes(1);
    ctl.resetPending();
    expect(ctl.busy()).toBe(false);
  });

  it('validates the custom amount against the server limits', async () => {
    const { ctl, api } = setup([summary({ minTopUpCents: 1000, maxTopUpCents: 20_000 })]);
    await ctl.load();
    expect(ctl.presets()).toEqual([1000, 2000, 5000]);

    ctl.setCustomInput('abc');
    expect(ctl.customCents()).toBeNull();
    expect(ctl.customError()).toMatch(/Enter an amount/);
    await ctl.topUpCustom();
    expect(ctl.customTouched()).toBe(true);

    ctl.setCustomInput('9.99');
    expect(ctl.customError()).toBe('The smallest top-up is $10.');
    await ctl.topUpCustom();

    ctl.setCustomInput('200.01');
    expect(ctl.customError()).toBe('The largest top-up is $200.');
    await ctl.topUpCustom();

    expect(api.createCheckout).not.toHaveBeenCalled();
  });

  it('a valid custom amount opens Checkout with the right cents', async () => {
    const { ctl, api, navigate } = setup();
    await ctl.load();
    ctl.setCustomInput('$12.34');
    expect(ctl.customError()).toBeNull();
    await ctl.topUpCustom();
    expect(api.createCheckout).toHaveBeenCalledWith(1234);
    expect(navigate).toHaveBeenCalledWith('https://checkout.stripe.com/c/1234');
    expect(ctl.pending()).toEqual({ kind: 'top-up', cents: 1234, source: 'custom' });
  });

  it('shows a checkout error inline and re-enables the buttons', async () => {
    const { ctl, api, navigate } = setup();
    await ctl.load();
    api.createCheckout.mockRejectedValueOnce(new Error('Billing is not configured'));
    await ctl.topUp(1000);
    expect(navigate).not.toHaveBeenCalled();
    expect(ctl.actionError()).toBe('Billing is not configured');
    expect(ctl.busy()).toBe(false);
  });

  it('refuses an out-of-range preset without calling the server', async () => {
    const { ctl, api } = setup();
    await ctl.load();
    await ctl.topUp(100);
    expect(api.createCheckout).not.toHaveBeenCalled();
    expect(ctl.actionError()).toBe('The smallest top-up is $5.');
  });
});

describe('BillingController: the membership', () => {
  it('Subscribe opens Checkout for the membership plan, back to the billing page', async () => {
    const { ctl, billing } = setup();
    await ctl.load();
    await ctl.subscribe();
    expect(billing.upgrade).toHaveBeenCalledWith(
      'membership',
      '/learn/billing?checkout=success',
      '/learn/billing?checkout=cancel',
      '/learn/billing',
    );
    expect(ctl.pending()).toEqual({ kind: 'subscribe' });
    // Leaving for Stripe: nothing else can start meanwhile.
    await ctl.topUp(500);
    expect(ctl.pending()).toEqual({ kind: 'subscribe' });
  });

  it("uses the app's billing path (the power app's is /billing)", async () => {
    const { ctl, billing } = setup([summary()], '/billing');
    await ctl.subscribe();
    expect(billing.upgrade).toHaveBeenCalledWith(
      'membership',
      '/billing?checkout=success',
      '/billing?checkout=cancel',
      '/billing',
    );
  });

  it('a subscribe error shows inline and re-enables the buttons', async () => {
    const { ctl, billing } = setup();
    billing.upgrade.mockRejectedValueOnce(new Error('Stripe is down'));
    await ctl.subscribe();
    expect(ctl.actionError()).toBe('Stripe is down');
    expect(ctl.busy()).toBe(false);
  });

  it('a redeemed code replaces the membership in the summary', async () => {
    const { ctl } = setup();
    await ctl.load();
    const waived = { ...summary().membership, status: 'waived' as const };
    ctl.setMembership(waived);
    expect(ctl.summary()?.membership.status).toBe('waived');
    expect(ctl.summary()?.balanceMicros).toBe(1_000_000);
  });
});

describe('BillingController: the portal', () => {
  it('"Manage billing" opens the portal and returns to the billing page', async () => {
    const { ctl, billing } = setup();
    await ctl.manage();
    expect(billing.portal).toHaveBeenCalledWith('/learn/billing');
    const power = setup([summary()], '/billing');
    await power.ctl.manage();
    expect(power.billing.portal).toHaveBeenCalledWith('/billing');
    expect(ctl.pending()).toEqual({ kind: 'portal' });
  });

  it('a portal error without a Stripe customer reads kindly', async () => {
    const { ctl, billing } = setup();
    billing.portal.mockRejectedValueOnce(
      Object.assign(new Error('Stripe customer not found for this user'), {
        name: 'BillingError',
        status: 404,
        code: 'CUSTOMER_NOT_FOUND',
      }),
    );
    await ctl.manage();
    expect(ctl.actionError()).toMatch(/nothing to manage yet/);
    expect(ctl.busy()).toBe(false);
  });
});
