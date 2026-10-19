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
// A call runs on its legs (hosted/legs.ts): the hosted backends that can
// serve its model, first choice first. It is sent on the first; its hold
// covers any of them. It falls back to the next only when a leg was refused
// (rate limited, overloaded, a server error, a failed connection) before it
// yielded anything: nothing was billed upstream and the client has seen
// nothing of it, so the payer is charged once, for the leg that answered, and
// no started reply is cut off. Its row is pointed at the next leg in one
// conditional statement; a refusal also opens the backend's breaker for the
// model (hosted/breaker.ts), which puts it last in later calls' chains for a while.
//
// Every metered call also logs one line at its end (call-log.ts).
import type {
  GenerateRequest,
  LlmProvider,
  ProviderError,
  ProviderErrorCode,
  ProviderEvent,
  ProviderRegistry,
} from '@tangent/shared';
import { decorateProvider, unreportedSearchFeeMicros } from '@tangent/providers';
import { tripBreaker } from '../hosted/breaker.js';
import { singleLeg, type HostedLeg, type LegsOf } from '../hosted/legs.js';
import { PoolRefusedError, PoolRequestTooLargeError } from '../pool/meter.js';
import { CallLog } from './call-log.js';
import type { MeterLeg, MeterRun, UsageMeter } from './meter-run.js';
import { CreditRefusedError } from './personal-meter.js';
import { logEvent } from '../log.js';

/** The errors that say a backend can't take the call just now, rather than that the call is wrong. */
const FALLBACK_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'rate_limit',
  'overloaded',
  'server',
  'network',
]);

/**
 * Whether a leg that ended in `error` before yielding anything may be retried
 * on the next: refused by the backend (`rejected`) or never sent there
 * (`not_sent`), so nothing was billed, for a reason of the backend's own.
 * A bad request, a context too long, a key or payment problem would fail the
 * same way anywhere; an `unknown` failure may have come after the request
 * went out; an abort is the caller's.
 */
function fallsBack(error: ProviderError): boolean {
  return (
    (error.upstream === 'not_sent' || error.upstream === 'rejected') &&
    FALLBACK_CODES.has(error.code)
  );
}

function meterLeg(leg: HostedLeg): MeterLeg {
  return {
    backend: leg.backend.id,
    backendModel: leg.model,
    searchFeeMicros: unreportedSearchFeeMicros(leg.provider.kind),
  };
}

async function* meteredStream(
  provider: LlmProvider,
  request: GenerateRequest,
  meter: UsageMeter,
  legsOf: LegsOf,
): AsyncGenerator<ProviderEvent> {
  const legs = legsOf(provider, request.model);
  let run: MeterRun;
  try {
    run = await meter.begin({
      tag: request.usageTag,
      providerId: provider.id,
      model: request.model,
      request,
      maxOutputTokens: provider.capabilities(request.model).maxOutputTokens,
      legs: legs.map(meterLeg),
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
    log = new CallLog(provider, run.request, meter.funding, legs[0]!);
    for (let i = 0; ; i++) {
      const leg = legs[i]!;
      const next = legs[i + 1];
      let yielded = false;
      let refused: ProviderError | null = null;
      // Upstream the model goes by the leg's id; the row, the log and the reply keep the logical one.
      for await (const event of leg.provider.stream({ ...run.request, model: leg.model })) {
        if (event.type === 'error') {
          tripBreaker(leg.backend.id, leg.model, event.error, Date.now());
          if (next && !yielded && fallsBack(event.error) && !run.request.signal.aborted) {
            refused = event.error;
            break;
          }
        }
        yielded = true;
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
      // The provider contract ends every stream in a terminal event; without one, `finally` settles.
      if (!refused || !next) return;
      if (!(await run.switchTo(meterLeg(next)))) {
        const event: ProviderEvent = { type: 'error', error: refused };
        run.observe(event);
        log.observe(event);
        finished = true;
        await run.finish();
        yield event;
        return;
      }
      logEvent('warn', 'backend_fallback', {
        usageId: run.usageId,
        from: leg.backend.id,
        to: next.backend.id,
        model: request.model,
        code: refused.code,
        status: refused.status ?? null,
        retryAfterMs: refused.retryAfterMs ?? null,
        purpose: request.usageTag?.purpose ?? 'other',
        funding: meter.funding,
      });
      log.fellBackTo(next);
    }
  } finally {
    // The consumer stopped reading early (a provider never throws, and always ends in a terminal event).
    if (!finished) await run.finish({ consumerStopped: true });
    log?.write(run.usageId);
  }
}

function meteredProvider(provider: LlmProvider, meter: UsageMeter, legsOf: LegsOf): LlmProvider {
  return decorateProvider(provider, {
    stream: (request) => meteredStream(provider, request, meter, legsOf),
  });
}

/**
 * Wraps `get(id).stream(req)` with the meter for the providers `metered`
 * accepts; the others pass through. The Worker (registries.ts) wraps only
 * registries whose every route is paid on the operator's key, so it accepts
 * all, and runs each call on its hosted legs (`hostedLegs`); by default a
 * call runs on the provider itself.
 */
export function meteredRegistry(
  inner: ProviderRegistry,
  meter: UsageMeter,
  metered: (providerId: string) => boolean,
  legsOf: LegsOf = singleLeg,
): ProviderRegistry {
  const cache = new WeakMap<LlmProvider, LlmProvider>();
  return {
    get(providerId) {
      const provider = inner.get(providerId);
      if (!provider || !metered(providerId)) return provider;
      let wrapped = cache.get(provider);
      if (!wrapped) {
        wrapped = meteredProvider(provider, meter, legsOf);
        cache.set(provider, wrapped);
      }
      return wrapped;
    },
    list: () => inner.list(),
    defaultProviderId: () => inner.defaultProviderId(),
  };
}
