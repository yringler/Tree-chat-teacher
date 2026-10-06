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
import { grantCredit } from '../../src/billing/ledger.js';
import type { AppEnv } from '../../src/env.js';
import { uniq } from './billing-helpers.js';

const NOW = '2026-10-05T12:00:00.000Z';

export function fakeRef(object: string): ProviderRef {
  return `fake:${object}:${uniq(object)}` as ProviderRef;
}

/** A credits payment: a $10 personal top-up with an 80¢ fee unless told otherwise. */
export function paid(
  o: {
    userId?: string | null;
    target?: 'personal' | 'unknown';
    accountId?: string | null;
    netCents?: number;
    taxCents?: number;
    feeCents?: number | null;
    estimated?: boolean;
    currency?: string;
    customerRef?: string | null;
    paymentRef?: ProviderRef;
  } = {},
): PaymentSucceeded {
  const fee = o.feeCents === null ? null : { cents: o.feeCents ?? 80, estimated: !!o.estimated };
  return {
    type: 'payment.succeeded',
    provider: 'fake',
    occurredAt: NOW,
    paymentRef: o.paymentRef ?? fakeRef('order'),
    purpose: {
      kind: 'credits',
      target: o.target ?? 'personal',
      accountId: o.accountId === undefined ? null : o.accountId,
    },
    userId: o.userId === undefined ? null : o.userId,
    customerRef: o.customerRef ?? null,
    currency: o.currency ?? 'usd',
    netCents: o.netCents ?? 1000,
    taxCents: o.taxCents ?? 0,
    fee,
  };
}

/**
 * A pool purchase as the ledger holds it from before the pool became
 * revenue-funded (nobody can buy one now): the grant the webhook wrote, net
 * of the fee, on `poolId`. Its refunds and disputes still debit the pool.
 */
export async function legacyPoolPurchase(
  env: AppEnv,
  o: { poolId: string; userId: string; netCents?: number; feeCents?: number },
): Promise<{ paymentRef: ProviderRef }> {
  const paymentRef = fakeRef('order');
  const net = o.netCents ?? 1000;
  const fee = o.feeCents ?? 80;
  await grantCredit(env.DB, {
    accountId: o.poolId,
    kind: 'purchase',
    amountMicros: (net - fee) * 10_000,
    grossMicros: net * 10_000,
    feeMicros: fee * 10_000,
    userId: o.userId,
    providerRef: paymentRef,
    note: 'Open pool purchase',
  });
  return { paymentRef };
}

/** A membership payment (the first year unless `cycle` says renewal). */
export function membershipPaid(
  userId: string | null,
  o: { cycle?: 'initial' | 'renewal'; netCents?: number; paymentRef?: ProviderRef } = {},
): PaymentSucceeded {
  return {
    type: 'payment.succeeded',
    provider: 'fake',
    occurredAt: NOW,
    paymentRef: o.paymentRef ?? fakeRef('order'),
    purpose: {
      kind: 'membership',
      cycle: o.cycle ?? 'initial',
      subscriptionRef: fakeRef('subscription'),
    },
    userId,
    customerRef: null,
    currency: 'usd',
    netCents: o.netCents ?? 1000,
    taxCents: 0,
    fee: { cents: 100, estimated: false },
  };
}

/** The facts `getPayment` reports for `event` (the fake provider's `payments` option). */
export function factsOf(event: PaymentSucceeded): PaymentFacts {
  const { paymentRef, purpose, userId, customerRef, currency, netCents, taxCents, fee } = event;
  return { paymentRef, purpose, userId, customerRef, currency, netCents, taxCents, fee };
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
    taxCents: 0,
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
