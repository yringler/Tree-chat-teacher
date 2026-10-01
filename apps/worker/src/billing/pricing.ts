// Wave 1 stub (foundation). Implemented in wave 2 by the `billing` agent.
//
// Integer money math (see PLAN §2.3): provider cost in nano-USD, ledger in
// micro-USD, charges rounded up, never down.

/** `Math.round(costUsd * 1e9)`. */
export function costUsdToNanos(_costUsd: number): number {
  throw new Error('not implemented');
}

/** `ceil(costNanos * (10_000 + markupBps) / 10_000_000)`, in integer math. */
export function chargeMicros(_costNanos: number, _markupBps: number): number {
  throw new Error('not implemented');
}

/** `cents * 10_000`. */
export function centsToMicros(_cents: number): number {
  throw new Error('not implemented');
}
