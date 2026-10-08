// Pure translation of Polar objects (API version 2026-10) into the port's
// normalised events. No I/O: the fixture tests run every mapping here.
//
// Field choices (the PLAUSIBLE ones are listed in
// docs/polar-migration/04-verification.md for the sandbox check):
// - an order's pre-tax amount is `net_amount` (after discounts, before tax),
//   never `total_amount`; its fee is `platform_fee_amount` (in
//   `platform_fee_currency`), else the configured estimate;
// - a refund's `amount` is pre-tax (its tax is `tax_amount`);
// - a dispute's `amount` includes its `tax_amount`, which is taken off;
// - a subscription's `modified_at` orders its snapshots.
import type { models } from '@polar-sh/sdk/2026-10';
import type { SubscriptionStatus } from '@tangent/shared';
import type {
  CreditsTarget,
  DisputeEvent,
  MembershipChanged,
  PaymentFacts,
  PaymentPurpose,
  ProviderRef,
  RefundSucceeded,
} from '../../payments/port.js';
import { providerRef } from '../../payments/refs.js';
import type { PolarConfig } from './config.js';

/** Checkout metadata `kind` values this app sets (copied by Polar onto orders and subscriptions). */
export const CREDITS_KIND = 'credits';
export const MEMBERSHIP_KIND = 'membership';

type Metadata = Record<string, string | number | boolean>;

function text(metadata: Metadata | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
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
      return {
        kind: 'membership',
        cycle: order.billing_reason === 'subscription_create' ? 'initial' : 'renewal',
        subscriptionRef: subscriptionRef(order.subscription_id),
      };
    return { kind: 'other' };
  }
  if (order.billing_reason === 'purchase' && text(metadata, 'kind') === CREDITS_KIND) {
    // Credit is sold only for the buyer's own ledger; anything else (a legacy
    // `pool` purchase) is not credited automatically.
    const raw = text(metadata, 'target');
    const target: CreditsTarget = raw === null || raw === 'personal' ? 'personal' : 'unknown';
    return { kind: 'credits', target, accountId: text(metadata, 'accountId') };
  }
  return { kind: 'other' };
}

/**
 * Polar's fee on an order, in USD cents: `platform_fee_amount` when it is a
 * USD fee Polar has set, else the configured estimate on the total
 * charged, rather than a retry that could disable the webhook endpoint.
 */
export function orderFee(
  order: models.Order,
  config: PolarConfig,
): { cents: number; estimated: boolean } {
  const currency = order.platform_fee_currency?.toLowerCase() ?? 'usd';
  const fee = order.platform_fee_amount;
  if (
    currency === 'usd' &&
    Number.isSafeInteger(fee) &&
    fee >= 0 &&
    (fee > 0 || order.total_amount === 0)
  )
    return { cents: fee, estimated: false };
  const { bps, fixedCents } = config.feeEstimate;
  return {
    cents: Math.ceil((Math.max(0, order.total_amount) * bps) / 10_000) + fixedCents,
    estimated: true,
  };
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
    taxCents: order.tax_amount,
    fee: orderFee(order, config),
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
    taxCents: refund.tax_amount,
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
