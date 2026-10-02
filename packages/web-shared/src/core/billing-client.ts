import { inject, Injectable } from '@angular/core';
import { AUTH_CLIENT, authErrorMessage } from './auth-client';

/** A row of the Better Auth Stripe plugin's `subscription` table, as `/subscription/list` returns it. */
export interface BillingSubscription {
  id: string;
  plan: string;
  referenceId: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  /** Stripe status: `active`, `trialing`, `past_due`, `canceled`, `incomplete`, ... */
  status: string;
  periodStart?: Date | string | null;
  periodEnd?: Date | string | null;
  cancelAtPeriodEnd?: boolean | null;
  cancelAt?: Date | string | null;
  canceledAt?: Date | string | null;
  endedAt?: Date | string | null;
}

/** Thrown when a plugin call fails; `message` is fit for the UI. */
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

/** `/learn/billing` → `https://host/learn/billing`; absolute URLs pass through. */
export function absoluteUrl(path: string, origin: string = location.origin): string {
  return new URL(path, origin).toString();
}

interface PluginError {
  message?: string | undefined;
  status?: number;
  code?: string | undefined;
}

/**
 * The membership and the Stripe customer portal, through the Better Auth
 * Stripe plugin (`/api/auth/subscription/*`), whose one plan is the
 * membership (`MEMBERSHIP_PLAN` in `@tangent/shared`). One-time top-ups are not the
 * plugin's: they go through `ApiClient.createCheckout`.
 *
 * Every redirect is done here with `location.assign` (the plugin is called
 * with `disableRedirect: true`), so callers can tell a failure from a
 * navigation: the promise rejects with a BillingError, or the page unloads.
 */
@Injectable({ providedIn: 'root' })
export class BillingClient {
  private readonly client = inject(AUTH_CLIENT);

  /**
   * Subscribes the caller to `plan` (the membership: `MEMBERSHIP_PLAN`) and
   * navigates to Stripe Checkout. `returnPath` (default `successPath`) is
   * where Stripe's portal sends the browser back when the plugin finds an
   * existing subscription to change instead.
   */
  async upgrade(
    plan: string,
    successPath: string,
    cancelPath: string,
    returnPath: string = successPath,
  ): Promise<void> {
    const { data, error } = await this.client.subscription.upgrade({
      plan,
      successUrl: absoluteUrl(successPath),
      cancelUrl: absoluteUrl(cancelPath),
      returnUrl: absoluteUrl(returnPath),
      disableRedirect: true,
    });
    if (error) throw toBillingError(error);
    navigate(urlOf(data));
  }

  /** Opens the Stripe customer portal (invoices, payment method, cancel), then back to `returnPath`. */
  async portal(returnPath: string): Promise<void> {
    const { data, error } = await this.client.subscription.billingPortal({
      returnUrl: absoluteUrl(returnPath),
      disableRedirect: true,
    });
    if (error) throw toBillingError(error);
    navigate(urlOf(data));
  }

  /** The caller's active and trialing subscriptions. */
  async list(): Promise<BillingSubscription[]> {
    const { data, error } = await this.client.subscription.list();
    if (error) throw toBillingError(error);
    return (data ?? []) as BillingSubscription[];
  }
}

function toBillingError(error: PluginError): BillingError {
  return new BillingError(authErrorMessage(error), error.status ?? null, error.code ?? null);
}

function urlOf(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'url' in data && typeof data.url === 'string')
    return data.url;
  throw new BillingError('Billing did not return a page to open. Please try again.');
}

function navigate(url: string): void {
  location.assign(url);
}
