import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api-client';
import { BillingClient, BillingError, openPortalTab, type PortalTab } from './billing-client';

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

function fakeTab() {
  return { show: vi.fn((_url: string) => undefined), close: vi.fn(() => undefined) };
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

  it('portal() points the given tab at the portal and leaves this page alone', async () => {
    const { billing, api } = setup();
    const tab: PortalTab = fakeTab();
    await billing.portal(tab);
    expect(api.billingPortal).toHaveBeenCalledOnce();
    expect(tab.show).toHaveBeenCalledWith('https://pay.example/portal/p1');
    expect(tab.close).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('portal() closes the tab and rejects with a BillingError when the server refuses', async () => {
    const { billing, api } = setup();
    api.billingPortal.mockRejectedValueOnce(
      new ApiError(404, 'no_customer', 'There is nothing to manage yet'),
    );
    const tab = fakeTab();
    const err = await billing.portal(tab).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingError);
    expect(err).toMatchObject({ status: 404, code: 'no_customer' });
    expect(tab.close).toHaveBeenCalledOnce();
    expect(tab.show).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('refuses an empty URL', async () => {
    const { billing, api } = setup();
    api.membershipCheckout.mockResolvedValueOnce({ url: '' });
    await expect(billing.upgrade()).rejects.toBeInstanceOf(BillingError);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('openPortalTab', () => {
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assign = vi.fn();
    vi.stubGlobal('location', { origin: 'https://tangent.test', assign });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens a blank tab, cuts its opener, and points it at the URL later', () => {
    const win = { location: { href: 'about:blank' }, opener: 'this-page', close: vi.fn() };
    const open = vi.fn((_url: string, _target: string) => win);
    vi.stubGlobal('window', { open });
    const tab = openPortalTab();
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(win.opener).toBeNull();
    expect(win.location.href).toBe('about:blank');
    tab.show('https://pay.example/portal/p1');
    expect(win.location.href).toBe('https://pay.example/portal/p1');
    expect(assign).not.toHaveBeenCalled();
    tab.close();
    expect(win.close).toHaveBeenCalledOnce();
  });

  it('falls back to this tab when the browser blocks the new one', () => {
    vi.stubGlobal('window', { open: vi.fn(() => null) });
    const tab = openPortalTab();
    tab.show('https://pay.example/portal/p1');
    expect(assign).toHaveBeenCalledWith('https://pay.example/portal/p1');
    expect(() => {
      tab.close();
    }).not.toThrow();
  });
});
