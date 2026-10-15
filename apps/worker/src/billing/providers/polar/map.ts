// Pure translation of Polar objects (API version 2026-10) into the port's
// normalised events. No I/O: the fixture tests run every mapping here.
//
// Field choices (some read from Polar's docs rather than seen on a live
// order, so check them against a sandbox order when the API version changes):
// - an order's pre-tax amount is `net_amount` (after discounts, before tax),
//   never `total_amount`;
// - a top-up's credit is the checkout metadata's `creditCents`, set by the
//   server (buyers can't change metadata);
// - a refund's `amount` is pre-tax (its tax is `tax_amount`);
// - a dispute's `amount` includes its `tax_amount`, which is taken off;
// - a subscription's `modified_at` orders its snapshots.
import type { models } from '@polar-sh/sdk/2026-10';
import type { SubscriptionStatus } from '@tangent/shared';
import {
  MEMBERSHIP_KIND,
  type DisputeEvent,
  type MembershipChanged,
  type PaymentFacts,
  type PaymentPurpose,
  type ProviderRef,
  type RefundSucceeded,
} from '../../payments/port.js';
import { providerRef } from '../../payments/refs.js';
import type { PolarConfig } from './config.js';

/** The checkout metadata `kind` of a top-up (copied by Polar onto its order); the membership's is `MEMBERSHIP_KIND`. */
export const CREDITS_KIND = 'credits';

type Metadata = Record<string, string | number | boolean>;

function text(metadata: Metadata | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A positive whole number of cents; null for anything else. */
function cents(metadata: Metadata, key: string): number | null {
  const value = metadata[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** An ISO timestamp in one canonical form, so versions compare as strings. */
function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function orderRef(orderId: string): ProviderRef {
  return providerRef('polar', 'order', orderId);
}

function subscriptionRef(subscriptionId: string): ProviderRef {
  return providerRef('polar', 'subscription', subscriptionId);
}

/** The order id of a `polar:order:<id>` ref; null for anything else. */
export function orderIdOf(ref: ProviderRef): string | null {
  const prefix = 'polar:order:';
  return ref.startsWith(prefix) && ref.length > prefix.length ? ref.slice(prefix.length) : null;
}

/** Our user: the customer's `external_id`, else the checkout metadata's `userId`. */
function userOf(customer: { external_id?: string | null }, metadata: Metadata): string | null {
  return customer.external_id || text(metadata, 'userId');
}

function isMembershipProduct(
  config: PolarConfig,
  productId: string | null,
  metadata: Metadata,
): boolean {
  return (
    (config.membershipProductId !== null && productId === config.membershipProductId) ||
    text(metadata, 'kind') === MEMBERSHIP_KIND
  );
}

/** What an order paid for. Membership: a subscription's first or renewal order only. */
function purposeOf(order: models.Order, config: PolarConfig): PaymentPurpose {
  const metadata = order.metadata ?? {};
  if (order.subscription_id && isMembershipProduct(config, order.product_id, metadata)) {
    if (
      order.billing_reason === 'subscription_create' ||
      order.billing_reason === 'subscription_cycle'
    )
      return { kind: 'membership' };
    return { kind: 'other' };
  }
  if (order.billing_reason === 'purchase' && text(metadata, 'kind') === CREDITS_KIND) {
    // Credit is sold only for the buyer's own ledger: an order for any other target is not credited.
    const target = text(metadata, 'target');
    const creditCents = cents(metadata, 'creditCents');
    return (target === null || target === 'personal') && creditCents !== null
      ? { kind: 'credits', creditCents }
      : { kind: 'other' };
  }
  return { kind: 'other' };
}

/** The facts of a paid order (`payment.succeeded`, or `getPayment`). */
export function orderFacts(order: models.Order, config: PolarConfig): PaymentFacts {
  const metadata = order.metadata ?? {};
  return {
    paymentRef: orderRef(order.id),
    purpose: purposeOf(order, config),
    userId: userOf(order.customer, metadata),
    customerRef: order.customer_id || null,
    currency: order.currency.toLowerCase(),
    netCents: order.net_amount,
  };
}

/** A settled refund; null while it is pending, or once it failed or was canceled. */
export function refundEvent(
  refund: models.Refund,
  occurredAt: string,
): Omit<RefundSucceeded, 'provider'> | null {
  if (refund.status !== 'succeeded') return null;
  return {
    type: 'refund.succeeded',
    occurredAt,
    refundRef: providerRef('polar', 'refund', refund.id),
    paymentRef: orderRef(refund.order_id),
    currency: refund.currency.toLowerCase(),
    netCents: refund.amount,
  };
}

/**
 * A dispute's outcome so far. `needs_response` and `under_review` mean the
 * funds are withdrawn or at risk; `prevented` and `early_warning` end in a
 * Polar refund instead (which arrives as a refund), so they map to nothing.
 */
export function disputeEvent(
  dispute: models.Dispute,
  occurredAt: string,
): Omit<DisputeEvent, 'provider'> | null {
  const type: DisputeEvent['type'] | null =
    dispute.status === 'needs_response' || dispute.status === 'under_review'
      ? 'dispute.opened'
      : dispute.status === 'lost'
        ? 'dispute.lost'
        : dispute.status === 'won'
          ? 'dispute.won'
          : null;
  if (!type) return null;
  return {
    type,
    occurredAt,
    disputeRef: providerRef('polar', 'dispute', dispute.id),
    paymentRef: orderRef(dispute.order_id),
    currency: dispute.currency.toLowerCase(),
    netCents: Math.max(0, dispute.amount - dispute.tax_amount),
  };
}

const STATUS: Record<models.Subscription['status'], SubscriptionStatus> = {
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'unpaid',
  paused: 'paused',
};

/**
 * The membership's snapshot from a subscription; null for any other
 * subscription, or one whose user is unknown (logged by the caller).
 */
export function membershipEvent(
  sub: models.Subscription,
  config: PolarConfig,
  occurredAt: string,
): Omit<MembershipChanged, 'provider'> | null {
  const metadata = sub.metadata ?? {};
  if (!isMembershipProduct(config, sub.product_id, metadata)) return null;
  const userId = userOf(sub.customer, metadata);
  if (!userId) return null;
  return {
    type: 'membership.changed',
    occurredAt,
    subscriptionRef: subscriptionRef(sub.id),
    userId,
    customerRef: sub.customer_id || null,
    status: STATUS[sub.status] ?? 'incomplete',
    providerStatus: sub.status,
    currentPeriodEnd: iso(sub.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    endedAt: iso(sub.ended_at),
    // Never modified yet: its creation time, which no later modification can precede.
    version: iso(sub.modified_at) ?? iso(sub.created_at) ?? occurredAt,
  };
}
