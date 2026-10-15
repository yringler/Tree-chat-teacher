import { inject, Injectable } from '@angular/core';
import { ApiClient, ApiError } from './api-client';

/** Thrown when the membership checkout or the billing portal can't open; `message` is fit for the UI. */
export class BillingError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

/**
 * Where the billing portal opens: `show` points the tab at the portal's URL, `close`
 * drops the tab when the portal can't open.
 */
export interface PortalTab {
  show(url: string): void;
  close(): void;
}

/**
 * A tab for the billing portal, opened now so the browser allows it: a popup
 * needs the click that asks for it, and the portal's URL only arrives after a
 * request. If the browser blocks the tab, the portal opens in this one instead.
 */
export function openPortalTab(): PortalTab {
  const win = window.open('', '_blank');
  if (!win) return { show: navigate, close: () => undefined };
  // `noopener` in the features would make `window.open` return null, so the
  // opener is cut afterwards: the portal tab must not reach back into this page.
  win.opener = null;
  return {
    show: (url) => {
      win.location.href = url;
    },
    close: () => {
      win.close();
    },
  };
}

/**
 * The membership and the billing portal: the server asks the payment provider
 * for a hosted page (`POST /api/billing/membership/checkout`, `/portal`) and
 * this navigates there. One-time top-ups go through `ApiClient.createCheckout`.
 *
 * `upgrade` navigates this page with `location.assign`, so callers can tell a
 * failure from a navigation: the promise rejects with a BillingError, or the
 * page unloads. `portal` points the given tab instead and leaves this page
 * where it is. The provider sends the browser back to the app's billing page.
 */
@Injectable({ providedIn: 'root' })
export class BillingClient {
  private readonly api = inject(ApiClient);

  /** Opens the membership's checkout (or, for a paying member, the billing portal). */
  async upgrade(): Promise<void> {
    navigate(await open(() => this.api.membershipCheckout()));
  }

  /**
   * Opens the billing portal (invoices, payment method, cancel) in `tab`. 404
   * `no_customer` when there is none yet; the tab is closed then.
   */
  async portal(tab: PortalTab): Promise<void> {
    let url: string;
    try {
      url = await open(() => this.api.billingPortal());
    } catch (err) {
      tab.close();
      throw err;
    }
    tab.show(url);
  }
}

async function open(request: () => Promise<{ url: string }>): Promise<string> {
  let url: string;
  try {
    ({ url } = await request());
  } catch (err) {
    if (err instanceof ApiError) throw new BillingError(err.message, err.status, err.code);
    throw err;
  }
  if (!url) throw new BillingError('Billing did not return a page to open. Please try again.');
  return url;
}

function navigate(url: string): void {
  location.assign(url);
}
