import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_CLIENT, type TangentAuthClient } from './auth-client';
import { absoluteUrl, BillingClient, BillingError } from './billing-client';

type Result = { data: unknown; error: { message?: string; status?: number; code?: string } | null };

function setup() {
  const subscription = {
    upgrade: vi.fn(async (_body: unknown): Promise<Result> => ({
      data: { url: 'https://checkout.stripe.com/c/sub', redirect: false },
      error: null,
    })),
    billingPortal: vi.fn(async (_body: unknown): Promise<Result> => ({
      data: { url: 'https://billing.stripe.com/p/1', redirect: false },
      error: null,
    })),
    list: vi.fn(async (): Promise<Result> => ({
      data: [{ id: 's1', plan: 'basic', referenceId: 'u1', status: 'active' }],
      error: null,
    })),
  };
  const injector = Injector.create({
    providers: [
      { provide: BillingClient },
      { provide: AUTH_CLIENT, useValue: { subscription } as unknown as TangentAuthClient },
    ],
  });
  return { billing: injector.get(BillingClient), subscription };
}

describe('BillingClient', () => {
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assign = vi.fn();
    vi.stubGlobal('location', { origin: 'https://tangent.test', assign });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('makes paths absolute from the origin', () => {
    expect(absoluteUrl('/learn/billing?checkout=success')).toBe(
      'https://tangent.test/learn/billing?checkout=success',
    );
    expect(absoluteUrl('https://elsewhere.test/x')).toBe('https://elsewhere.test/x');
  });

  it('upgrade() asks for a checkout without redirect, then navigates to it', async () => {
    const { billing, subscription } = setup();
    await billing.upgrade('basic', '/learn/billing?checkout=success', '/learn/billing');
    expect(subscription.upgrade).toHaveBeenCalledWith({
      plan: 'basic',
      successUrl: 'https://tangent.test/learn/billing?checkout=success',
      cancelUrl: 'https://tangent.test/learn/billing',
      returnUrl: 'https://tangent.test/learn/billing?checkout=success',
      disableRedirect: true,
    });
    expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/sub');
  });

  it('portal() opens the returned portal URL', async () => {
    const { billing, subscription } = setup();
    await billing.portal('/learn/billing');
    expect(subscription.billingPortal).toHaveBeenCalledWith({
      returnUrl: 'https://tangent.test/learn/billing',
      disableRedirect: true,
    });
    expect(assign).toHaveBeenCalledWith('https://billing.stripe.com/p/1');
  });

  it('rejects with a BillingError and stays on the page when the plugin fails', async () => {
    const { billing, subscription } = setup();
    subscription.upgrade.mockResolvedValueOnce({
      data: null,
      error: { message: 'Already subscribed', status: 400, code: 'ALREADY_SUBSCRIBED_PLAN' },
    });
    const err = await billing.upgrade('basic', '/a', '/b').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingError);
    expect(err).toMatchObject({ message: 'Already subscribed', code: 'ALREADY_SUBSCRIBED_PLAN' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('list() returns the subscriptions', async () => {
    const { billing } = setup();
    await expect(billing.list()).resolves.toEqual([
      { id: 's1', plan: 'basic', referenceId: 'u1', status: 'active' },
    ]);
  });
});
