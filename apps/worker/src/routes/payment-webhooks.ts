import type { Context } from 'hono';
import { applyPaymentEvent } from '../billing/payments/apply.js';
import { webhookProvider, WebhookSignatureError } from '../billing/payments/index.js';
import type { AppBindings } from '../env.js';
import { apiError } from '../http/errors.js';

/**
 * `POST /api/webhooks/:provider` (public; registered before the session
 * check): a payment provider's webhook deliveries, e.g. `/api/webhooks/polar`.
 * The contract is the same for every provider (03-architecture.md §2.4):
 *
 * - an unknown or inactive provider: 404;
 * - a bad signature: 403 (`WebhookSignatureError`);
 * - verified but nothing to act on: 202;
 * - each event applied in order (billing/payments/apply.ts); any failure,
 *   including "retry later", answers 500 so the provider redelivers, and is
 *   logged as `payment_webhook_failed`. Polar disables an endpoint after 10
 *   consecutive failures: alert on that log line.
 *
 * The body is read raw: signatures are computed over the exact bytes.
 */
export async function paymentWebhookRoute(c: Context<AppBindings>): Promise<Response> {
  const id = c.req.param('provider') ?? '';
  const provider = webhookProvider(c.env, id);
  if (!provider) return apiError(c, 'not_found', 'Route not found');
  const rawBody = await c.req.text();
  let parsed;
  try {
    parsed = await provider.parseWebhook({ rawBody, headers: c.req.raw.headers });
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      console.warn(
        JSON.stringify({ event: 'payment_webhook_rejected', provider: id, reason: err.message }),
      );
      return apiError(c, 'forbidden', 'Invalid webhook signature');
    }
    throw err;
  }
  if (parsed.kind === 'ignored') return c.json({ received: true }, 202);
  try {
    for (const event of parsed.events) await applyPaymentEvent(c.env, event, { provider });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'payment_webhook_failed',
        provider: id,
        deliveryId: parsed.deliveryId,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      }),
    );
    return c.json({ received: false }, 500);
  }
  return c.json({ received: true });
}
