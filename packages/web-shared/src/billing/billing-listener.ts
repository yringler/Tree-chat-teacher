import { InjectionToken } from '@angular/core';
import type { BillingSummary } from '@tangent/shared';

/**
 * Optional: told about every billing summary the billing page reads (first
 * load, polling after a checkout, a redeemed code), so an app can update its
 * own balance and membership state without another request.
 */
export const BILLING_SUMMARY_LISTENER = new InjectionToken<(summary: BillingSummary) => void>(
  'BILLING_SUMMARY_LISTENER',
);
