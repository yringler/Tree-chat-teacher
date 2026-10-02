import type { BillingSummary, UsageEntry, UsageListResponse } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  BILLING_PATH,
  BillingController,
  CHECKOUT_CANCEL_PATH,
  CHECKOUT_SUCCESS_PATH,
  POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
  USAGE_PAGE_SIZE,
} from './billing-controller';

function summary(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    enabled: true,
    builtInCredit: true,
    currency: 'usd',
    balanceMicros: 1_000_000,
    heldMicros: 0,
    availableMicros: 1_000_000,
    markupBps: 1000,
    openRouterFeeBps: 550,
    subscription: null,
    monthlyPlans: [
      { name: 'basic', label: 'Basic', amountCents: 1000 },
      { name: 'plus', label: 'Plus', amountCents: 2000 },
    ],
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
  };
}

/** A fake world: `billing()` returns `summaries` in order, then repeats the last one. */
function setup(summaries: BillingSummary[] = [summary()]) {
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
  const ctl = new BillingController({ api, billing, navigate, clearCheckoutParam, sleep });
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

  it('stops when a new plan shows up even if no credit landed yet', async () => {
    const before = summary();
    const after = summary({
      subscription: { plan: 'basic', status: 'active', periodEnd: null, cancelAtPeriodEnd: false },
    });
    const { ctl, api } = setup([before, after]);
    await ctl.init('success');
    expect(api.billing).toHaveBeenCalledTimes(2);
    expect(ctl.notice()).toBe('credited');
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

describe('BillingController: plans and the portal', () => {
  it('choosing a plan goes through the plugin with the billing return paths', async () => {
    const { ctl, billing } = setup();
    await ctl.load();
    await ctl.choosePlan(ctl.summary()!.monthlyPlans[1]!);
    expect(billing.upgrade).toHaveBeenCalledWith(
      'plus',
      CHECKOUT_SUCCESS_PATH,
      CHECKOUT_CANCEL_PATH,
      BILLING_PATH,
    );
    expect(CHECKOUT_SUCCESS_PATH).toBe('/learn/billing?checkout=success');
    expect(CHECKOUT_CANCEL_PATH).toBe('/learn/billing?checkout=cancel');
    expect(ctl.pending()).toEqual({ kind: 'plan', plan: 'plus' });
  });

  it('knows the current plan, including one that is cancelling', async () => {
    const sub = {
      plan: 'basic',
      status: 'active',
      periodEnd: '2026-11-01T00:00:00.000Z',
      cancelAtPeriodEnd: true,
    };
    const { ctl } = setup([summary({ subscription: sub, markupBps: 500 })]);
    await ctl.load();
    expect(ctl.currentPlan()).toEqual(sub);
  });

  it('a cancelled subscription is not a current plan', async () => {
    const { ctl } = setup([
      summary({
        subscription: {
          plan: 'basic',
          status: 'canceled',
          periodEnd: null,
          cancelAtPeriodEnd: false,
        },
      }),
    ]);
    await ctl.load();
    expect(ctl.currentPlan()).toBeNull();
  });

  it('"Manage billing" opens the portal and returns to the billing page', async () => {
    const { ctl, billing } = setup();
    await ctl.manage();
    expect(billing.portal).toHaveBeenCalledWith('/learn/billing');
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

  it('other plugin errors are shown as they are', async () => {
    const { ctl, billing } = setup();
    billing.upgrade.mockRejectedValueOnce(
      Object.assign(
        new Error('Email verification is required before you can subscribe to a plan'),
        {
          code: 'EMAIL_VERIFICATION_REQUIRED',
        },
      ),
    );
    await ctl.choosePlan({ name: 'basic', label: 'Basic', amountCents: 1000 });
    expect(ctl.actionError()).toBe(
      'Email verification is required before you can subscribe to a plan',
    );
    expect(ctl.busy()).toBe(false);
  });
});
