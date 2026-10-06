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
 * The membership and the billing portal: the server asks the payment provider
 * for a hosted page (`POST /api/billing/membership/checkout`, `/portal`) and
 * this navigates there. One-time top-ups go through `ApiClient.createCheckout`.
 *
 * Every redirect is done here with `location.assign`, so callers can tell a
 * failure from a navigation: the promise rejects with a BillingError, or the
 * page unloads. The provider sends the browser back to the app's billing page.
 */
@Injectable({ providedIn: 'root' })
export class BillingClient {
  private readonly api = inject(ApiClient);

  /** Opens the membership's checkout (or, for a paying member, the billing portal). */
  async upgrade(): Promise<void> {
    navigate(await open(() => this.api.membershipCheckout()));
  }

  /** Opens the billing portal (invoices, payment method, cancel). 404 `no_customer` when there is none yet. */
  async portal(): Promise<void> {
    navigate(await open(() => this.api.billingPortal()));
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
