// Wave 1 stub (foundation). Implemented in wave 2 by the `billing` agent.
//
// Usage metering for simple accounts (PLAN §2.4): a `ProviderRegistry`
// decorator that records one `usage_events` row per provider call.
import type { ProviderEvent, ProviderRegistry, UsageTag } from '@tangent/shared';
import type { AccountContext, AppEnv } from '../env.js';

export interface UsageMeter {
  /** Inserts the pending row (awaited) before the upstream call starts. */
  begin(info: { tag: UsageTag | undefined; providerId: string; model: string }): Promise<MeterRun>;
}

export interface MeterRun {
  /** Taps every provider event (`billing`, `usage`, ...). */
  observe(event: ProviderEvent): void;
  /** Settles inline when the cost is known, else defers reconciliation. */
  finish(): Promise<void>;
}

/** `defer` keeps background work alive (`ctx.waitUntil` in the DO / Worker). */
export function createUsageMeter(
  _env: AppEnv,
  _account: AccountContext,
  _defer: (p: Promise<unknown>) => void,
): UsageMeter {
  throw new Error('not implemented');
}

/** Wraps `get(id).stream(req)` of every provider with the meter. */
export function meteredRegistry(_inner: ProviderRegistry, _meter: UsageMeter): ProviderRegistry {
  throw new Error('not implemented');
}
