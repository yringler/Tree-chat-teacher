// How an open pool call is settled (docs/pool/PLAN.md §1.2, deviation D2):
// one pure function shared by the meter, the expiry alarm and the cron.
//
// A reservation is released in full only when nothing can have been billed
// upstream: the request was never dispatched, or it failed before it was sent
// or was rejected with a non-2xx status. Once dispatched, the call is charged
// what it is known to have cost (reported cost, a generation lookup, tokens ×
// the price table), and the full hold when nothing was observed: the operator
// never pays for upstream work the pool did not pay for.
import type { ProviderUpstream } from '@tangent/shared';
import { costUsdToNanos } from '../billing/pricing.js';
import type { SettleReason } from '../billing/usage-store.js';
import type { ModelPrice } from '../config.js';
import { costFromTokensNanos } from './pricing.js';

export interface PoolSettleFacts {
  /** `dispatched_at` is set: the request was handed to the provider. */
  dispatched: boolean;
  /** From the call's terminal error event, when the provider knows it. */
  upstream?: ProviderUpstream | null;
  /** Cost the stream reported (USD). */
  costUsd?: number | null;
  /** Cost a generation lookup returned (USD). */
  generationCostUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** The pool model's price, to price observed tokens; null = no tokens settlement. */
  price?: ModelPrice | null;
}

export type PoolSettlement =
  | { reason: 'released'; costNanos: 0 }
  | { reason: Extract<SettleReason, 'cost' | 'generation' | 'tokens'>; costNanos: number }
  | { reason: 'hold'; costNanos: null };

function usd(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function tokens(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * The settlement of a pool call, in this order: released (never sent, or
 * refused upstream) → reported cost → generation lookup → tokens × price
 * (both counts observed) → the full hold. Costs are nano-USD before fees; the settle applies the row's
 * fee and clamps the charge to its hold.
 */
export function poolSettlement(f: PoolSettleFacts): PoolSettlement {
  if (!f.dispatched) return { reason: 'released', costNanos: 0 };
  if (f.upstream === 'not_sent' || f.upstream === 'rejected')
    return { reason: 'released', costNanos: 0 };
  if (usd(f.costUsd)) return { reason: 'cost', costNanos: costUsdToNanos(f.costUsd) };
  if (usd(f.generationCostUsd))
    return { reason: 'generation', costNanos: costUsdToNanos(f.generationCostUsd) };
  // Both counts: providers report them together at the end, so one alone means a
  // stream cut short whose output is unknown.
  if (f.price && tokens(f.inputTokens) && tokens(f.outputTokens)) {
    return {
      reason: 'tokens',
      costNanos: costFromTokensNanos(f.price, f.inputTokens, f.outputTokens),
    };
  }
  return { reason: 'hold', costNanos: null };
}
