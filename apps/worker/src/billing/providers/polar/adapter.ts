// Polar (https://polar.sh) as a `PaymentProvider`: Polar is the merchant of
// record, so it computes and remits tax and issues invoices; the app sells
// prepaid credit (a one-time product with an ad-hoc USD price per checkout)
// and the yearly membership (a recurring product). The adapter is stateless:
// it calls the API and maps what comes back (map.ts), and never touches D1.
//
// - Customers are addressed by our user id (`external_customer_id`), so no
//   customer is created ahead of a checkout and none is stored to find one.
// - Webhooks: Standard Webhooks signatures, verified by the SDK's
//   `validateEvent` over the raw body. `order.paid`, `refund.created/updated`
//   and `subscription.*` are mapped; every other signed type is ignored.
// - Disputes have no webhooks: `disputes.poll` lists them for the cron.
import {
  PolarClientError,
  PolarError,
  PolarNetworkError,
  PolarRateLimitError,
  PolarServerError,
} from '@polar-sh/sdk';
import { webhooks, type models } from '@polar-sh/sdk/2026-10';
import {
  PaymentProviderError,
  WebhookSignatureError,
  type DisputeEvent,
  type PaymentEvent,
  type PaymentProvider,
  type WebhookParseResult,
} from '../../payments/port.js';
import { getPolar } from './client.js';
import type { PolarConfig } from './config.js';
import {
  CREDITS_KIND,
  disputeEvent,
  MEMBERSHIP_KIND,
  membershipEvent,
  orderFacts,
  orderIdOf,
  refundEvent,
} from './map.js';

/** Bumped when the checkout metadata this adapter writes changes shape. */
const METADATA_VERSION = 1;
/** Disputes the poller reads per run: the newest pages, up to this many (100 each). */
const DISPUTE_POLL_PAGES = 3;
/** The dispute states worth an event (prevented and early-warning disputes end in refunds). */
const POLLED_DISPUTE_STATUSES: models.Dispute['status'][] = [
  'needs_response',
  'under_review',
  'lost',
  'won',
];

const SUBSCRIPTION_EVENTS = new Set<string>([
  'subscription.created',
  'subscription.updated',
  'subscription.active',
  'subscription.canceled',
  'subscription.uncanceled',
  'subscription.revoked',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
  'subscription.migrated',
  'subscription.cycled',
]);

/** Any SDK failure as a PaymentProviderError (429, 5xx and network errors are retryable). */
function providerError(action: string, err: unknown): PaymentProviderError {
  if (err instanceof PaymentProviderError) return err;
  if (err instanceof PolarRateLimitError)
    return new PaymentProviderError(`Polar ${action}: rate limited`, 429, true);
  if (err instanceof PolarServerError)
    return new PaymentProviderError(`Polar ${action}: ${err.message}`, err.statusCode, true);
  if (err instanceof PolarNetworkError)
    return new PaymentProviderError(`Polar ${action}: ${err.message}`, null, true);
  if (err instanceof PolarClientError)
    return new PaymentProviderError(`Polar ${action}: ${err.message}`, err.statusCode, false);
  if (err instanceof PolarError)
    return new PaymentProviderError(`Polar ${action}: ${err.message}`, null, false);
  const message = err instanceof Error ? err.message : String(err);
  // Timeouts surface as DOMException (AbortSignal.timeout): worth a retry.
  return new PaymentProviderError(`Polar ${action}: ${message}`, null, true);
}

function isNotFound(err: unknown): boolean {
  return err instanceof PolarClientError && err.statusCode === 404;
}

/**
 * Polar's answer to a customer session for an external id it has no customer
 * for: not a 404 but a 422 validation error on the body field, `{ detail: [{
 * loc: ['body', 'external_customer_id'], msg: 'Customer does not exist.' }] }`.
 */
function isUnknownCustomer(err: unknown): boolean {
  if (!(err instanceof PolarClientError) || err.statusCode !== 422) return false;
  const detail = (err.error as { detail?: unknown } | null)?.detail;
  return (
    Array.isArray(detail) &&
    detail.some((d: unknown) => {
      const loc = (d as { loc?: unknown } | null)?.loc;
      return Array.isArray(loc) && loc.at(-1) === 'external_customer_id';
    })
  );
}

function notConfigured(what: string): PaymentProviderError {
  return new PaymentProviderError(`Polar: no ${what} product is configured`, null, false);
}

export function createPolarProvider(config: PolarConfig): PaymentProvider {
  const polar = () => getPolar(config);

  async function pollDisputes(now: Date): Promise<readonly DisputeEvent[]> {
    const events: DisputeEvent[] = [];
    const occurredAt = now.toISOString();
    try {
      for (let page = 1; page <= DISPUTE_POLL_PAGES; page++) {
        const list = await polar().disputes.list({
          status: POLLED_DISPUTE_STATUSES,
          sorting: ['-created_at'],
          limit: 100,
          page,
        });
        for (const dispute of list.items) {
          const event = disputeEvent(dispute, occurredAt);
          if (event) events.push({ ...event, provider: 'polar' });
        }
        if (page >= list.pagination.max_page) break;
      }
    } catch (err) {
      throw providerError('disputes.list', err);
    }
    return events;
  }

  return {
    id: 'polar',
    capabilities: {
      topUps: config.creditsProductId !== null,
      membership: config.membershipProductId !== null,
    },
    disputes: { mode: 'poll', poll: pollDisputes },

    async createTopUpCheckout(input) {
      const productId = config.creditsProductId;
      if (!productId) throw notConfigured('credits');
      try {
        const checkout = await polar().checkouts.create({
          products: [productId],
          // An ad-hoc price for this checkout only: the amount the buyer chose, before tax.
          prices: {
            [productId]: [
              {
                amount_type: 'fixed',
                price_amount: input.amountCents,
                price_currency: 'usd',
                tax_behavior: 'exclusive',
              },
            ],
          },
          currency: 'usd',
          external_customer_id: input.buyer.userId,
          customer_email: input.buyer.email,
          customer_name: input.buyer.name,
          // Copied onto the order: what the webhook credits, and to whom.
          metadata: {
            kind: CREDITS_KIND,
            target: 'personal',
            accountId: input.accountId,
            userId: input.buyer.userId,
            v: METADATA_VERSION,
          },
          success_url: input.successUrl,
          return_url: input.cancelUrl,
        });
        return { url: checkout.url };
      } catch (err) {
        throw providerError('checkouts.create', err);
      }
    },

    async createMembershipCheckout(input) {
      const productId = config.membershipProductId;
      if (!productId) throw notConfigured('membership');
      try {
        const checkout = await polar().checkouts.create({
          products: [productId],
          currency: 'usd',
          external_customer_id: input.buyer.userId,
          customer_email: input.buyer.email,
          customer_name: input.buyer.name,
          // Copied onto the subscription and each of its orders.
          metadata: { kind: MEMBERSHIP_KIND, userId: input.buyer.userId, v: METADATA_VERSION },
          success_url: input.successUrl,
          return_url: input.cancelUrl,
        });
        return { url: checkout.url };
      } catch (err) {
        throw providerError('checkouts.create', err);
      }
    },

    async createPortalSession(input) {
      try {
        const session = await polar().customerSessions.create({
          external_customer_id: input.buyer.userId,
          return_url: input.returnUrl,
        });
        return { url: session.customer_portal_url, customerRef: session.customer_id };
      } catch (err) {
        if (isUnknownCustomer(err) || isNotFound(err)) return null;
        throw providerError('customerSessions.create', err);
      }
    },

    async deleteCustomer(buyer) {
      // Revoke first: whether deleting a customer ends its subscriptions is not documented.
      let revoked = 0;
      try {
        const subs = await polar().subscriptions.list({
          external_customer_id: buyer.userId,
          active: true,
          limit: 100,
        });
        for (const sub of subs.items) {
          await polar().subscriptions.revoke(sub.id);
          revoked++;
        }
      } catch (err) {
        if (!isNotFound(err)) throw providerError('subscriptions.revoke', err);
      }
      try {
        // Anonymised, not erased: Polar keeps the order records tax law requires.
        await polar().customers.deleteExternal(buyer.userId, { anonymize: true });
        return 'deleted';
      } catch (err) {
        if (isNotFound(err)) return revoked > 0 ? 'deleted' : 'absent';
        throw providerError('customers.deleteExternal', err);
      }
    },

    async parseWebhook(req): Promise<WebhookParseResult> {
      const deliveryId = req.headers.get('webhook-id');
      let payload: webhooks.WebhookPayload;
      try {
        payload = await webhooks.validateEvent(
          req.rawBody,
          {
            'webhook-id': deliveryId ?? '',
            'webhook-timestamp': req.headers.get('webhook-timestamp') ?? '',
            'webhook-signature': req.headers.get('webhook-signature') ?? '',
          },
          config.webhookSecret,
        );
      } catch (err) {
        if (err instanceof webhooks.PolarWebhookVerificationError)
          throw new WebhookSignatureError(err.message);
        if (err instanceof webhooks.PolarWebhookUnknownTypeError)
          return { kind: 'ignored', deliveryId, reason: `unknown type ${err.eventType ?? '?'}` };
        // Signed, but unreadable: retrying the same bytes can't help.
        console.error(JSON.stringify({ event: 'polar_webhook_unreadable', deliveryId }));
        return { kind: 'ignored', deliveryId, reason: 'unreadable payload' };
      }
      if (!deliveryId) throw new WebhookSignatureError('Missing webhook-id');
      const events = toEvents(payload, config);
      if (events.length === 0) return { kind: 'ignored', deliveryId, reason: payload.type };
      return { kind: 'events', deliveryId, events };
    },

    async getPayment(paymentRef) {
      const orderId = orderIdOf(paymentRef);
      if (!orderId) return null;
      try {
        return orderFacts(await polar().orders.get(orderId), config);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw providerError('orders.get', err);
      }
    },
  };
}

/** The events one verified delivery carries (none for types and states we don't act on). */
function toEvents(payload: webhooks.WebhookPayload, config: PolarConfig): PaymentEvent[] {
  const occurredAt = payload.timestamp;
  switch (payload.type) {
    case 'order.paid':
      // order.created and order.updated arrive while pending: only a paid order is money.
      return [
        {
          type: 'payment.succeeded',
          provider: 'polar',
          occurredAt,
          ...orderFacts(payload.data, config),
        },
      ];
    case 'refund.created':
    case 'refund.updated': {
      const event = refundEvent(payload.data, occurredAt);
      return event ? [{ ...event, provider: 'polar' }] : [];
    }
    default: {
      if (!SUBSCRIPTION_EVENTS.has(payload.type)) return [];
      const sub = payload.data as models.Subscription;
      const event = membershipEvent(sub, config, occurredAt);
      if (!event && sub.metadata?.['kind'] === MEMBERSHIP_KIND)
        console.error(
          JSON.stringify({ event: 'polar_membership_without_user', subscriptionId: sub.id }),
        );
      return event ? [{ ...event, provider: 'polar' }] : [];
    }
  }
}
