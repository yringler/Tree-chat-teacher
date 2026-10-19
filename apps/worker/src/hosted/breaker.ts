// The hosted backends' circuit breaker: a backend that just said it is rate
// limited, overloaded or failing for a model goes to the end of that model's
// chains in this isolate until its window passes, so later calls start on the
// next backend instead of paying a refused round trip first, and stay there
// (the prompt cache is per backend, so flapping back and forth would miss it
// twice). It moves the backend rather than dropping it: the call's hold covers
// every leg, and the backend stays a fallback if the others refuse too. It is
// keyed by backend and the backend's model id, as a backend's rate limits are
// per model: a rate limit on Sonnet says nothing about Haiku. It is per
// isolate and best effort: another isolate learns from its own first refusal,
// which the meter's fallback covers. A window only ever expires: a call that
// falls back onto the backend meanwhile and succeeds says little about when
// its limit lifts.
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

/** When each backend's breaker for a model closes (ms since the epoch), by `breakerKey`. */
const openUntil = new Map<string, number>();

function breakerKey(backend: HostedBackendId, model: string): string {
  return `${backend}\n${model}`;
}

/**
 * How long `error`, from a call on a backend, puts the backend last in new
 * chains for the model; null when it says nothing about the backend's health. A rate limit
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

/**
 * Opens `backend`'s breaker for `model` (the backend's id of it) for
 * `error`'s window (`breakerWindowMs`) from `now`; never shortens one already open.
 */
export function tripBreaker(
  backend: HostedBackendId,
  model: string,
  error: ProviderError,
  now: number,
): void {
  const windowMs = breakerWindowMs(error);
  if (windowMs === null) return;
  const key = breakerKey(backend, model);
  const untilMs = now + windowMs;
  if ((openUntil.get(key) ?? 0) >= untilMs) return;
  openUntil.set(key, untilMs);
  logEvent('warn', 'backend_circuit_open', { backend, model, untilMs, reason: error.code });
}

/** Whether `backend`'s breaker for `model` (the backend's id of it) is open at `now`. */
export function breakerOpen(backend: HostedBackendId, model: string, now: number): boolean {
  const key = breakerKey(backend, model);
  const untilMs = openUntil.get(key);
  if (untilMs === undefined) return false;
  if (untilMs > now) return true;
  openUntil.delete(key);
  return false;
}

/**
 * `chain` with the legs whose breaker is open at `now` moved to its end:
 * the closed ones first, then the open ones, each in the chain's order.
 */
export function openBackendsLast<T extends { backend: { id: HostedBackendId }; model: string }>(
  chain: readonly T[],
  now: number,
): T[] {
  const open = chain.map(({ backend, model }) => breakerOpen(backend.id, model, now));
  return [...chain.filter((_, i) => !open[i]), ...chain.filter((_, i) => open[i])];
}

/** Closes every breaker: the test suites share one isolate. */
export function resetBreakers(): void {
  openUntil.clear();
}
