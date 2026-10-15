import type { BillingSummary, UsageEntry, UsageListResponse } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import type { PortalTab } from '../core/billing-client';
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
      subscriptionStatus: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      priceCents: 1000,
    },
    builtInCredit: true,
    currency: 'usd',
    balanceMicros: 1_000_000,
    heldMicros: 0,
    availableMicros: 1_000_000,
    serviceFee: { bps: 2000, fixedCents: 50 },
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
      url: `https://pay.example/checkout/${amountCents}`,
    })),
  };
  const billing = {
    upgrade: vi.fn(async () => undefined),
    portal: vi.fn(async (_tab: PortalTab) => undefined),
  };
  const tab = { show: vi.fn((_url: string) => undefined), close: vi.fn(() => undefined) };
  const openTab = vi.fn((): PortalTab => tab);
  const navigate = vi.fn((_url: string) => undefined);
  const clearCheckoutParam = vi.fn(() => undefined);
  const sleep = vi.fn(async (_ms: number) => undefined);
  const ctl = new BillingController({
    api,
    billing,
    openTab,
    navigate,
    clearCheckoutParam,
    sleep,
  });
  return { ctl, api, billing, tab, openTab, navigate, clearCheckoutParam, sleep };
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

  it('stops when the membership becomes active, which wins over a balance change', async () => {
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
  it('Add credit waits for an amount; a preset selects one and prices it', async () => {
    const { ctl, api, navigate } = setup();
    await ctl.load();
    expect(ctl.presets()).toEqual([500, 1000, 2000, 5000]);
    expect(ctl.selectedCents()).toBeNull();
    expect(ctl.breakdown()).toBeNull();
    await ctl.addCredit();
    expect(api.createCheckout).not.toHaveBeenCalled();

    ctl.selectPreset(500);
    expect(ctl.selectedPreset()).toBe(500);
    // 20% + 50¢ of $5.
    expect(ctl.breakdown()).toEqual({ creditCents: 500, feeCents: 150, subtotalCents: 650 });
    await ctl.addCredit();
    expect(api.createCheckout).toHaveBeenCalledWith(500);
    expect(navigate).toHaveBeenCalledWith('https://pay.example/checkout/500');
    expect(ctl.pending()).toEqual({ kind: 'top-up', cents: 500 });
    // The page is leaving: everything stays disabled.
    expect(ctl.busy()).toBe(true);
    await ctl.addCredit();
    expect(api.createCheckout).toHaveBeenCalledTimes(1);
    ctl.resetPending();
    expect(ctl.busy()).toBe(false);
  });

  it('typing an amount replaces the preset, and the breakdown follows it', async () => {
    const { ctl } = setup();
    await ctl.load();
    ctl.selectPreset(2000);
    ctl.setCustomInput('$12.34');
    expect(ctl.selectedPreset()).toBeNull();
    // 20% of $12.34 is 246.8¢, rounded up, + 50¢.
    expect(ctl.breakdown()).toEqual({ creditCents: 1234, feeCents: 297, subtotalCents: 1531 });
    ctl.setCustomInput('abc');
    expect(ctl.breakdown()).toBeNull();
    ctl.selectPreset(1000);
    expect(ctl.customInput()).toBe('');
    expect(ctl.breakdown()).toEqual({ creditCents: 1000, feeCents: 250, subtotalCents: 1250 });
  });

  it('prices with the server’s service fee', async () => {
    const { ctl } = setup([summary({ serviceFee: { bps: 1500, fixedCents: 0 } })]);
    await ctl.load();
    ctl.selectPreset(2000);
    expect(ctl.breakdown()).toEqual({ creditCents: 2000, feeCents: 300, subtotalCents: 2300 });
  });

  it('validates the custom amount against the server limits', async () => {
    const { ctl, api } = setup([summary({ minTopUpCents: 1000, maxTopUpCents: 20_000 })]);
    await ctl.load();
    expect(ctl.presets()).toEqual([1000, 2000, 5000]);

    ctl.setCustomInput('abc');
    expect(ctl.customCents()).toBeNull();
    expect(ctl.customError()).toMatch(/Enter an amount/);
    await ctl.addCredit();
    expect(ctl.customTouched()).toBe(true);

    ctl.setCustomInput('9.99');
    expect(ctl.customError()).toBe('The smallest top-up is $10.');
    expect(ctl.breakdown()).toBeNull();
    await ctl.addCredit();

    ctl.setCustomInput('200.01');
    expect(ctl.customError()).toBe('The largest top-up is $200.');
    await ctl.addCredit();

    expect(api.createCheckout).not.toHaveBeenCalled();
  });

  it('shows a checkout error inline and re-enables the buttons', async () => {
    const { ctl, api, navigate } = setup();
    await ctl.load();
    api.createCheckout.mockRejectedValueOnce(new Error('Billing is not configured'));
    ctl.selectPreset(1000);
    await ctl.addCredit();
    expect(navigate).not.toHaveBeenCalled();
    expect(ctl.actionError()).toBe('Billing is not configured');
    expect(ctl.busy()).toBe(false);
  });
});

describe('BillingController: the membership', () => {
  it('Subscribe opens the membership checkout (the server picks the return page)', async () => {
    const { ctl, billing } = setup();
    await ctl.load();
    await ctl.subscribe();
    expect(billing.upgrade).toHaveBeenCalledOnce();
    expect(ctl.pending()).toEqual({ kind: 'subscribe' });
    // Leaving for the checkout: nothing else can start meanwhile.
    ctl.selectPreset(500);
    await ctl.addCredit();
    expect(ctl.pending()).toEqual({ kind: 'subscribe' });
  });

  it('a subscribe error shows inline and re-enables the buttons', async () => {
    const { ctl, billing } = setup();
    billing.upgrade.mockRejectedValueOnce(new Error('Payments are down'));
    await ctl.subscribe();
    expect(ctl.actionError()).toBe('Payments are down');
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
  it('"Manage billing" opens its tab during the click, before the portal URL arrives', () => {
    const { ctl, openTab } = setup();
    void ctl.manage();
    expect(openTab).toHaveBeenCalledOnce();
    expect(ctl.pending()).toEqual({ kind: 'portal' });
  });

  it('hands the tab to the portal and leaves this page where it is', async () => {
    const { ctl, billing, tab, navigate } = setup();
    await ctl.manage();
    expect(billing.portal).toHaveBeenCalledWith(tab);
    expect(tab.close).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('clears "Opening…" once the tab is pointed, so the button works again', async () => {
    const { ctl } = setup();
    await ctl.manage();
    expect(ctl.pending()).toBeNull();
    expect(ctl.busy()).toBe(false);
    expect(ctl.actionError()).toBeNull();
  });

  it('a portal error without a customer yet reads kindly', async () => {
    const { ctl, billing } = setup();
    billing.portal.mockRejectedValueOnce(
      Object.assign(new Error('No customer'), {
        name: 'BillingError',
        status: 404,
        code: 'no_customer',
      }),
    );
    await ctl.manage();
    expect(ctl.actionError()).toMatch(/nothing to manage yet/);
    expect(ctl.busy()).toBe(false);
  });

  it('a second click while the tab is being pointed opens no second tab', async () => {
    const { ctl, openTab } = setup();
    const first = ctl.manage();
    void ctl.manage();
    await first;
    expect(openTab).toHaveBeenCalledOnce();
  });
});
