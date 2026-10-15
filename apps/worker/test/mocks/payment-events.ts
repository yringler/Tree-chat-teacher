// Builders for normalised payment events (billing/payments/port.ts), so the
// domain suites test what a payment does without any provider's wire format.
// Refs are unique per call (`fake:<object>:<uniq>`).
import type {
  DisputeEvent,
  MembershipChanged,
  PaymentFacts,
  PaymentSucceeded,
  ProviderRef,
  RefundSucceeded,
} from '../../src/billing/payments/port.js';
import type { SubscriptionStatus } from '@tangent/shared';
import { uniq } from './billing-helpers.js';

const NOW = '2026-10-05T12:00:00.000Z';

export function fakeRef(object: string): ProviderRef {
  return `fake:${object}:${uniq(object)}` as ProviderRef;
}

/** A credits payment: $10 paid for $9.20 of credit unless told otherwise. */
export function paid(
  o: {
    userId?: string | null;
    netCents?: number;
    creditCents?: number;
    currency?: string;
    customerRef?: string | null;
    paymentRef?: ProviderRef;
  } = {},
): PaymentSucceeded {
  return {
    type: 'payment.succeeded',
    provider: 'fake',
    occurredAt: NOW,
    paymentRef: o.paymentRef ?? fakeRef('order'),
    purpose: { kind: 'credits', creditCents: o.creditCents ?? 920 },
    userId: o.userId === undefined ? null : o.userId,
    customerRef: o.customerRef ?? null,
    currency: o.currency ?? 'usd',
    netCents: o.netCents ?? 1000,
  };
}

/** A membership payment. */
export function membershipPaid(
  userId: string | null,
  o: { netCents?: number; paymentRef?: ProviderRef } = {},
): PaymentSucceeded {
  return {
    type: 'payment.succeeded',
    provider: 'fake',
    occurredAt: NOW,
    paymentRef: o.paymentRef ?? fakeRef('order'),
    purpose: { kind: 'membership' },
    userId,
    customerRef: null,
    currency: 'usd',
    netCents: o.netCents ?? 1000,
  };
}

/** The facts `getPayment` reports for `event` (the fake provider's `payments` option). */
export function factsOf(event: PaymentSucceeded): PaymentFacts {
  const { paymentRef, purpose, userId, customerRef, currency, netCents } = event;
  return { paymentRef, purpose, userId, customerRef, currency, netCents };
}

export function refunded(
  paymentRef: ProviderRef,
  netCents: number,
  o: { refundRef?: ProviderRef; currency?: string } = {},
): RefundSucceeded {
  return {
    type: 'refund.succeeded',
    provider: 'fake',
    occurredAt: NOW,
    refundRef: o.refundRef ?? fakeRef('refund'),
    paymentRef,
    currency: o.currency ?? 'usd',
    netCents,
  };
}

export function disputed(
  type: DisputeEvent['type'],
  paymentRef: ProviderRef,
  netCents: number,
  disputeRef: ProviderRef = fakeRef('dispute'),
): DisputeEvent {
  return {
    type,
    provider: 'fake',
    occurredAt: NOW,
    disputeRef,
    paymentRef,
    currency: 'usd',
    netCents,
  };
}

export function membership(
  userId: string,
  status: SubscriptionStatus,
  o: {
    subscriptionRef?: ProviderRef;
    version?: string;
    currentPeriodEnd?: string | null;
    cancelAtPeriodEnd?: boolean;
    customerRef?: string | null;
  } = {},
): MembershipChanged {
  return {
    type: 'membership.changed',
    provider: 'fake',
    occurredAt: NOW,
    subscriptionRef: o.subscriptionRef ?? fakeRef('subscription'),
    userId,
    customerRef: o.customerRef ?? null,
    status,
    providerStatus: status,
    currentPeriodEnd:
      o.currentPeriodEnd === undefined ? '2027-10-05T12:00:00.000Z' : o.currentPeriodEnd,
    cancelAtPeriodEnd: o.cancelAtPeriodEnd ?? false,
    endedAt: status === 'canceled' ? NOW : null,
    version: o.version ?? NOW,
  };
}
