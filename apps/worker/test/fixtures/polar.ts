// SYNTHETIC Polar fixtures: hand-written from the @polar-sh/sdk 1.0.2 types
// (API version 2026-10), NOT recorded from a real Polar delivery. Every
// object is checked against the SDK's models by the type checker, but the
// values of the fields marked PLAUSIBLE in docs/polar-migration/04-verification.md
// (`platform_fee_amount` at order.paid, `Refund.amount` being pre-tax,
// `Dispute.amount` including tax, `Subscription.modified_at`) are assumptions.
// Replace these with recorded sandbox deliveries (04-verification.md §2).
import type { models, webhooks } from '@polar-sh/sdk/2026-10';

export const SYNTHETIC = true;

const T0 = '2026-10-05T12:00:00.000Z';
const ORG = '7f0c7f3e-0000-4000-8000-000000000001';

export function customer(externalId: string | null): models.OrderCustomer {
  return {
    id: `cus_of_${externalId ?? 'anon'}`,
    created_at: T0,
    modified_at: null,
    metadata: {},
    external_id: externalId,
    email: `${externalId ?? 'anon'}@example.com`,
    email_verified: true,
    type: 'individual',
    name: 'Ada',
    billing_name: 'Ada',
    billing_address: null,
    tax_id: null,
    organization_id: ORG,
    deleted_at: null,
    first_user_event_at: null,
    avatar_url: null,
  };
}

/** A paid order: by default a $10.00 personal credit top-up, $0.87 tax, Polar fee 104¢. */
export function order(
  o: Partial<models.Order> & { externalId?: string | null } = {},
): models.Order {
  const { externalId = 'user_1', ...rest } = o;
  const net = rest.net_amount ?? 1000;
  const tax = rest.tax_amount ?? 87;
  return {
    id: 'ord_1',
    created_at: T0,
    modified_at: T0,
    status: 'paid',
    paid: true,
    subtotal_amount: net,
    discount_amount: 0,
    net_amount: net,
    tax_amount: tax,
    total_amount: net + tax,
    applied_balance_amount: 0,
    due_amount: 0,
    refunded_amount: 0,
    refunded_tax_amount: 0,
    currency: 'usd',
    billing_reason: 'purchase',
    billing_name: 'Ada',
    billing_address: null,
    invoice_number: 'INV-1',
    is_invoice_generated: false,
    receipt_number: null,
    units: null,
    customer_id: `cus_of_${externalId ?? 'anon'}`,
    product_id: 'prod_credits',
    discount_id: null,
    subscription_id: null,
    checkout_id: 'polar_c_1',
    metadata: {
      kind: 'credits',
      target: 'personal',
      accountId: `u_${externalId}`,
      userId: externalId ?? '',
      v: 1,
    },
    platform_fee_amount: 104,
    platform_fee_currency: 'usd',
    customer: customer(externalId),
    product: null,
    discount: null,
    subscription: null,
    items: [],
    description: 'Credit',
    refundable_amount: net,
    refundable_tax_amount: tax,
    ...rest,
  };
}

export function refund(o: Partial<models.Refund> = {}): models.Refund {
  return {
    created_at: T0,
    modified_at: T0,
    id: 'ref_1',
    metadata: {},
    status: 'succeeded',
    reason: 'customer_request',
    amount: 500,
    tax_amount: 44,
    currency: 'usd',
    organization_id: ORG,
    order_id: 'ord_1',
    subscription_id: null,
    customer_id: 'cus_of_user_1',
    revoke_benefits: false,
    dispute: null,
    ...o,
  };
}

export function subscription(
  o: Partial<models.Subscription> & { externalId?: string | null } = {},
): models.Subscription {
  const { externalId = 'user_1', ...rest } = o;
  return {
    created_at: T0,
    modified_at: '2026-10-05T12:00:05.000Z',
    id: 'sub_1',
    amount: 1000,
    currency: 'usd',
    recurring_interval: 'year',
    recurring_interval_count: 1,
    status: 'active',
    current_period_start: T0,
    current_period_end: '2027-10-05T12:00:00.000Z',
    current_meter_period_start: null,
    current_meter_period_end: null,
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    started_at: T0,
    ends_at: null,
    ended_at: null,
    pause_at_period_end: false,
    paused_at: null,
    resumes_at: null,
    customer_id: `cus_of_${externalId ?? 'anon'}`,
    product_id: 'prod_membership',
    discount_id: null,
    checkout_id: 'polar_c_2',
    units: null,
    customer_cancellation_reason: null,
    customer_cancellation_comment: null,
    metadata: { kind: 'membership', userId: externalId ?? '', v: 1 },
    customer: customer(externalId),
    product: {} as models.Product,
    discount: null,
    prices: [],
    meters: [],
    pending_update: null,
    ...rest,
  };
}

export function dispute(o: Partial<models.Dispute> = {}): models.Dispute {
  return {
    created_at: T0,
    modified_at: T0,
    id: 'dsp_1',
    status: 'needs_response',
    resolved: false,
    closed: false,
    amount: 1087,
    tax_amount: 87,
    currency: 'usd',
    reason: 'fraudulent',
    evidence_due_by: '2026-10-20T00:00:00.000Z',
    past_due: false,
    order_id: 'ord_1',
    payment_id: 'pay_1',
    customer: customer('user_1'),
    case_id: null,
    ...o,
  };
}

/** A webhook envelope as Polar posts it. */
export function envelope<T extends webhooks.WebhookPayload['type']>(
  type: T,
  data: Extract<webhooks.WebhookPayload, { type: T }>['data'],
  timestamp = T0,
): Extract<webhooks.WebhookPayload, { type: T }> {
  return { type, timestamp, api_version: '2026-10', data } as Extract<
    webhooks.WebhookPayload,
    { type: T }
  >;
}

/** A Standard Webhooks secret: `whsec_` + base64 of 32 bytes. */
export const TEST_WEBHOOK_SECRET = `whsec_${btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)))}`;

/**
 * Signs `body` as Polar does (Standard Webhooks): HMAC-SHA256, keyed with the
 * base64-decoded part of the secret after `whsec_`, over `${id}.${ts}.${body}`.
 */
export async function signStandardWebhook(
  body: string,
  secret: string = TEST_WEBHOOK_SECRET,
  o: { id?: string; timestamp?: number } = {},
): Promise<Headers> {
  const id = o.id ?? `msg_${crypto.randomUUID()}`;
  const ts = o.timestamp ?? Math.floor(Date.now() / 1000);
  const raw = atob(secret.slice('whsec_'.length));
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(raw, (c) => c.charCodeAt(0)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`)),
  );
  return new Headers({
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': `v1,${btoa(String.fromCharCode(...mac))}`,
  });
}
