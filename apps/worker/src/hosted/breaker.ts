// The hosted backends' circuit breaker: a backend that just said it is rate
// limited, overloaded or failing is left out of the chains this isolate builds
// until its window passes, so later calls start on the next backend instead of
// paying a refused round trip first, and stay there (the prompt cache is per
// backend, so flapping back and forth would miss it twice). It is per isolate
// and best effort: another isolate learns from its own first refusal, which
// the meter's fallback covers. A window only ever expires; a success on the
// backend meanwhile doesn't close it, as no call is sent there while it is open.
import type { ProviderError } from '@tangent/shared';
import type { HostedBackendId } from './backend.js';
import { logEvent } from '../log.js';

/** The shortest a rate limit or overload opens the breaker, whatever `retry-after` says. */
export const BREAKER_MIN_MS = 30_000;
/**
 * The longest it stays open: a backend that asks for longer (up to the hour
 * `retry-after` is capped at) is tried again after this, and a refusal then
 * costs one round trip before the fallback.
 */
export const BREAKER_MAX_MS = 5 * 60_000;
/**
 * The window of a server error or a failed connection, which say nothing of
 * when to come back: long enough that an outage costs each isolate one failed
 * round trip per window rather than one per call, short enough that a lone
 * 500 moves calls (and their prompt cache) off the backend only briefly.
 */
export const BREAKER_FAILURE_MS = 30_000;

/** The breaker's clock, a seam for tests. */
export const breakerClock = { now: (): number => Date.now() };

const openUntil = new Map<HostedBackendId, number>();

/**
 * How long `error`, from a call on a backend, keeps the backend out of new
 * chains; null when it says nothing about the backend's health. A rate limit
 * or an overload opens it for its `retry-after`, within BREAKER_MIN_MS and
 * BREAKER_MAX_MS, mid-stream too; a server error or a failed connection only
 * when the upstream refused the call or never got it (`upstream`), as one
 * that broke mid-stream may be the connection's fault, not the backend's.
 */
export function breakerWindowMs(error: ProviderError): number | null {
  if (error.code === 'rate_limit' || error.code === 'overloaded') {
    return Math.min(BREAKER_MAX_MS, Math.max(BREAKER_MIN_MS, error.retryAfterMs ?? 0));
  }
  const refused = error.upstream === 'not_sent' || error.upstream === 'rejected';
  if ((error.code === 'server' || error.code === 'network') && refused) return BREAKER_FAILURE_MS;
  return null;
}

/** Opens `backend`'s breaker for `error`'s window (`breakerWindowMs`); never shortens one already open. */
export function tripBreaker(backend: HostedBackendId, error: ProviderError): void {
  const windowMs = breakerWindowMs(error);
  if (windowMs === null) return;
  const untilMs = breakerClock.now() + windowMs;
  if ((openUntil.get(backend) ?? 0) >= untilMs) return;
  openUntil.set(backend, untilMs);
  logEvent('warn', 'backend_circuit_open', { backend, untilMs, reason: error.code });
}

/** Whether `backend` is left out of new chains right now. */
export function breakerOpen(backend: HostedBackendId): boolean {
  const untilMs = openUntil.get(backend);
  if (untilMs === undefined) return false;
  if (untilMs > breakerClock.now()) return true;
  openUntil.delete(backend);
  return false;
}

/** `chain` without the backends whose breaker is open, or all of it when that would leave none. */
export function withoutOpenBackends<T extends { backend: { id: HostedBackendId } }>(
  chain: readonly T[],
): T[] {
  const closed = chain.filter(({ backend }) => !breakerOpen(backend.id));
  return closed.length > 0 ? closed : [...chain];
}

/** Closes every breaker (tests). */
export function resetBreakers(): void {
  openUntil.clear();
}
