// Usage metering for the built-in provider: a `ProviderRegistry`
// decorator that records one `usage_events` row per call on a metered
// provider. Who pays is the meter's funding:
//
// - credit (`createUsageMeter`, personal-meter.ts): the user's ledger;
// - the open pool (`createPoolUsageMeter`, pool/meter.ts).
//
// Either holds the call's worst case before anything is sent upstream and
// settles the row at the terminal event. Once the row exists nothing here
// throws into the chat stream: failed writes are retried in the background
// and the cron (reconcile.ts) and, for the pool, PoolBank's expiry alarm are
// the backstops.
//
// Every metered call also logs one line at its end (call-log.ts).
import type {
  GenerateRequest,
  LlmProvider,
  ProviderEvent,
  ProviderRegistry,
} from '@tangent/shared';
import { decorateProvider } from '@tangent/providers';
import { PoolRefusedError, PoolRequestTooLargeError } from '../pool/meter.js';
import { CallLog } from './call-log.js';
import type { MeterRun, UsageMeter } from './meter-run.js';
import { CreditRefusedError } from './personal-meter.js';
import { logEvent } from '../log.js';

async function* meteredStream(
  provider: LlmProvider,
  request: GenerateRequest,
  meter: UsageMeter,
): AsyncGenerator<ProviderEvent> {
  let run: MeterRun;
  try {
    run = await meter.begin({
      tag: request.usageTag,
      providerId: provider.id,
      model: request.model,
      request,
      maxOutputTokens: provider.capabilities(request.model).maxOutputTokens,
    });
  } catch (e) {
    // No row, no upstream call: the provider contract is "never throw", so fail as an event.
    if (e instanceof CreditRefusedError) {
      yield {
        type: 'error',
        error: {
          code: e.code,
          message: e.message,
          retryable: e.code === 'server',
          upstream: 'not_sent',
        },
      };
      return;
    }
    if (e instanceof PoolRefusedError) {
      yield {
        type: 'error',
        error: {
          code:
            e.refusal.reason === 'empty' || e.refusal.reason === 'unpriced'
              ? 'server'
              : 'rate_limit',
          message: 'The open pool cannot cover this request right now.',
          retryable: false,
          upstream: 'not_sent',
        },
      };
      return;
    }
    if (e instanceof PoolRequestTooLargeError) {
      yield {
        type: 'error',
        error: {
          code: 'context_length',
          message: 'This conversation is too long for the open pool.',
          retryable: false,
          upstream: 'not_sent',
        },
      };
      return;
    }
    logEvent('error', 'usage_meter_unavailable', { error: e });
    yield {
      type: 'error',
      error: {
        code: 'server',
        message: 'Usage metering is unavailable; please try again shortly',
        retryable: true,
        upstream: 'not_sent',
      },
    };
    return;
  }
  let finished = false;
  /** Set once the call is sent upstream: only those are logged. */
  let log: CallLog | null = null;
  try {
    let dispatched = false;
    try {
      dispatched = await run.dispatch();
    } catch (e) {
      logEvent('error', 'usage_dispatch_failed', { error: e });
    }
    if (!dispatched) {
      // Nothing was sent: the reservation (if it still exists) is released.
      finished = true;
      await run.finish();
      yield {
        type: 'error',
        error: {
          code: 'server',
          message: 'This request could not be started; please try again',
          retryable: true,
          upstream: 'not_sent',
        },
      };
      return;
    }
    log = new CallLog(provider, run.request, meter.funding);
    for await (const event of provider.stream(run.request)) {
      run.observe(event);
      log.observe(event);
      if (event.type === 'done' || event.type === 'error') {
        finished = true;
        await run.finish();
        yield event;
        return;
      }
      yield event;
    }
  } finally {
    // The consumer stopped early, the provider ended without a terminal event, or dispatch failed.
    if (!finished) await run.finish();
    log?.write(run.usageId);
  }
}

function meteredProvider(provider: LlmProvider, meter: UsageMeter): LlmProvider {
  return decorateProvider(provider, {
    stream: (request) => meteredStream(provider, request, meter),
  });
}

/**
 * Wraps `get(id).stream(req)` with the meter for the providers `metered`
 * accepts; the others pass through. The Worker (registries.ts) wraps only
 * registries whose every route is paid on the operator's key, so it accepts all.
 */
export function meteredRegistry(
  inner: ProviderRegistry,
  meter: UsageMeter,
  metered: (providerId: string) => boolean,
): ProviderRegistry {
  const cache = new WeakMap<LlmProvider, LlmProvider>();
  return {
    get(providerId) {
      const provider = inner.get(providerId);
      if (!provider || !metered(providerId)) return provider;
      let wrapped = cache.get(provider);
      if (!wrapped) {
        wrapped = meteredProvider(provider, meter);
        cache.set(provider, wrapped);
      }
      return wrapped;
    },
    list: () => inner.list(),
    defaultProviderId: () => inner.defaultProviderId(),
  };
}
