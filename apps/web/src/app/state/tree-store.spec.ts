import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import { Router } from '@angular/router';
import type { BillingSummary, MeResponse, MembershipInfo } from '@tangent/shared';
import { ApiClient, ApiError } from '@tangent/web-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeStore } from './tree-store';
import { UiStore } from './ui-store';

function membership(over: Partial<MembershipInfo> = {}): MembershipInfo {
  return {
    required: true,
    status: 'active',
    subscriptionStatus: 'active',
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
    includedCreditCents: 500,
    ...over,
  };
}

function me(over: Partial<MeResponse> = {}): MeResponse {
  return {
    email: 'a@example.com',
    userId: '1',
    accountId: 'p_1',
    mode: 'power',
    devMode: false,
    operatorKeys: false,
    builtInCredit: true,
    sharing: true,
    isAdmin: false,
    membership: membership(),
    featuredConversations: false,
    ...over,
  };
}

const summary = { availableMicros: 2_500_000 } as BillingSummary;

function setup() {
  const api = {
    providers: vi.fn(async () => []),
    listTrees: vi.fn(async () => []),
    keyStatus: vi.fn(async () => ({ enabled: true, hasKey: false, providers: [] })),
    billing: vi.fn(async (): Promise<BillingSummary> => summary),
  };
  const injector = Injector.create({
    providers: [
      { provide: TreeStore },
      { provide: UiStore },
      { provide: ApiClient, useValue: api },
      { provide: Router, useValue: { navigate: vi.fn(async () => true) } },
    ],
  });
  return { store: injector.get(TreeStore), ui: injector.get(UiStore), api };
}

describe('TreeStore membership and credit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the membership from me; on load it blocks only without a membership or credit', async () => {
    const s = setup();
    await s.store.init(me());
    expect(s.store.membership()?.status).toBe('active');
    expect(s.store.membershipBlocked()).toBe(false);
    expect(s.api.billing).not.toHaveBeenCalled();

    // No membership, but credit left: Tangent credit still works, so no gate.
    await s.store.init(me({ membership: membership({ status: 'inactive' }) }));
    expect(s.api.billing).toHaveBeenCalled();
    expect(s.store.creditCarriesOn()).toBe(true);
    expect(s.store.membershipBlocked()).toBe(false);

    await s.store.init(me({ membership: membership({ required: false, status: 'inactive' }) }));
    expect(s.store.membershipBlocked()).toBe(false);
  });

  it('blocks on load without a membership when the balance is used up or credit is not sold', async () => {
    const s = setup();
    s.api.billing.mockResolvedValue({ availableMicros: 0 } as BillingSummary);
    await s.store.init(me({ membership: membership({ status: 'inactive' }) }));
    expect(s.store.membershipBlocked()).toBe(true);
    expect(s.store.membershipDismissible()).toBe(false);

    const t = setup();
    await t.store.init(
      me({ builtInCredit: false, membership: membership({ status: 'inactive' }) }),
    );
    expect(t.api.billing).not.toHaveBeenCalled();
    expect(t.store.membershipBlocked()).toBe(true);
  });

  it('a 402 membership_required raises the gate without a toast; with credit left it can be dismissed', async () => {
    const s = setup();
    await s.store.init(me());
    s.store.fail(new ApiError(402, 'membership_required', 'Membership required'));
    expect(s.store.membershipBlocked()).toBe(true);
    expect(s.ui.toasts()).toEqual([]);
    await vi.waitFor(() => expect(s.store.billing()).toBe(summary));
    expect(s.store.membershipDismissible()).toBe(true);
    s.store.dismissMembershipGate();
    expect(s.store.membershipBlocked()).toBe(false);
    // Another own-key call refused: the gate again.
    s.store.fail(new ApiError(402, 'membership_required', 'Membership required'));
    expect(s.store.membershipBlocked()).toBe(true);
  });

  it('a 402 payment_required links to /billing and refreshes the balance', async () => {
    const s = setup();
    await s.store.init(me());
    s.store.fail(new ApiError(402, 'payment_required', 'Not enough credit'));
    expect(s.ui.toasts()).toEqual([
      expect.objectContaining({
        kind: 'error',
        text: 'Not enough credit',
        link: { label: 'Add credit', path: '/billing' },
      }),
    ]);
    expect(s.store.membershipBlocked()).toBe(false);
    await vi.waitFor(() => expect(s.store.billing()).toBe(summary));
  });

  it('key_required still opens the keys dialog', async () => {
    const s = setup();
    await s.store.init(me());
    s.store.fail(new ApiError(401, 'key_required', 'Add your key'));
    expect(s.ui.keysDialog()).toEqual({ provider: null });
    expect(s.ui.toasts()[0]?.link).toBeUndefined();
  });

  it('refreshBilling keeps quiet when the summary fails', async () => {
    const s = setup();
    s.api.billing.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    await s.store.refreshBilling();
    expect(s.store.billing()).toBeNull();
    expect(s.ui.toasts()).toEqual([]);
    await s.store.refreshBilling();
    expect(s.store.billing()).toBe(summary);
  });

  it('a summary from the billing page lifts the gate once the membership is active', async () => {
    const s = setup();
    s.api.billing.mockResolvedValue({ availableMicros: 0 } as BillingSummary);
    await s.store.init(me({ membership: membership({ status: 'inactive' }) }));
    expect(s.store.membershipBlocked()).toBe(true);
    const paid = { ...summary, membership: membership({ status: 'active' }) };
    s.store.applyBilling(paid);
    expect(s.store.membershipBlocked()).toBe(false);
    expect(s.store.billing()).toBe(paid);
  });
});
