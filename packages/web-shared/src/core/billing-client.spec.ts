import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api-client';
import { BillingClient, BillingError } from './billing-client';

function setup() {
  const api = {
    membershipCheckout: vi.fn(async () => ({ url: 'https://pay.example/checkout/c1' })),
    billingPortal: vi.fn(async () => ({ url: 'https://pay.example/portal/p1' })),
  };
  const injector = Injector.create({
    providers: [{ provide: BillingClient }, { provide: ApiClient, useValue: api }],
  });
  return { billing: injector.get(BillingClient), api };
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

  it('upgrade() asks the server for the membership checkout, then navigates to it', async () => {
    const { billing, api } = setup();
    await billing.upgrade();
    expect(api.membershipCheckout).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith('https://pay.example/checkout/c1');
  });

  it('portal() opens the billing portal', async () => {
    const { billing, api } = setup();
    await billing.portal();
    expect(api.billingPortal).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith('https://pay.example/portal/p1');
  });

  it('rejects with a BillingError and stays on the page when the server refuses', async () => {
    const { billing, api } = setup();
    api.billingPortal.mockRejectedValueOnce(
      new ApiError(404, 'no_customer', 'There is nothing to manage yet'),
    );
    const err = await billing.portal().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingError);
    expect(err).toMatchObject({ status: 404, code: 'no_customer' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('refuses an empty URL', async () => {
    const { billing, api } = setup();
    api.membershipCheckout.mockResolvedValueOnce({ url: '' });
    await expect(billing.upgrade()).rejects.toBeInstanceOf(BillingError);
    expect(assign).not.toHaveBeenCalled();
  });
});
