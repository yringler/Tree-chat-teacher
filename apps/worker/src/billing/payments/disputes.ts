// The dispute poller (cron, `CronJobs.paymentDisputes`): for providers whose
// disputes reach us only by polling (`DisputeSource.mode === 'poll'`; Polar
// has no dispute webhooks). Every event goes through `applyPaymentEvent`,
// which dedupes on the dispute refs, so polling the same disputes again is a
// no-op. One event's failure is logged and retried on the next run.
import type { AppEnv } from '../../env.js';
import { applyPaymentEvent } from './apply.js';
import { paymentProvider } from './index.js';
import type { PaymentProvider } from './port.js';
import { logEvent } from '../../log.js';

export interface DisputePollResult {
  /** False when there is no provider, or it doesn't need polling. */
  polled: boolean;
  applied: number;
  failed: number;
}

export async function pollDisputes(
  env: AppEnv,
  now: Date,
  provider: PaymentProvider | null = paymentProvider(env),
): Promise<DisputePollResult> {
  const result: DisputePollResult = { polled: false, applied: 0, failed: 0 };
  if (!provider || provider.disputes.mode !== 'poll') return result;
  const events = await provider.disputes.poll(now);
  result.polled = true;
  for (const event of events) {
    try {
      if ((await applyPaymentEvent(env, event, { provider })) === 'applied') result.applied++;
    } catch (err) {
      result.failed++;
      logEvent('error', 'dispute_poll_apply_failed', {
        provider: provider.id,
        disputeRef: event.disputeRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
