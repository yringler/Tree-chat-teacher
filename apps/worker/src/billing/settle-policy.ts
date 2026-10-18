// How a metered call is settled, on credit or the open pool: one pure
// function shared by both meters, the pool's expiry alarm and its cron.
//
// A call is charged nothing only when nothing can have been billed upstream:
// the request was never dispatched, or it failed before it was sent or was
// rejected with a non-2xx status. Once dispatched, the call is charged what
// it is known to have cost (reported cost, a generation lookup, tokens × the
// model's price), and the full hold when nothing was observed: Tangent never
// pays OpenRouter for work the call's payer was not charged for.
import { costUsdToNanos, type ProviderUpstream } from '@tangent/shared';
import type { SettleReason } from './usage-store.js';
import type { ModelPrice } from '../config.js';
import { costFromTokensNanos } from '../pool/pricing.js';

export interface SettleFacts {
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
  /** Of `inputTokens`, those read from / written to the prompt cache, when reported. */
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  /** The model's price (the pool's, or credit's list price), to price observed tokens; null = no tokens settlement. */
  price?: ModelPrice | null;
}

export type MeteredSettlement =
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
 * The settlement of a metered call, in this order: released (never sent, or
 * refused upstream) → reported cost → generation lookup → tokens × price
 * (both counts observed) → the full hold. Costs are nano-USD before fees; the
 * settle applies the row's fee and markup, and clamps a pool charge to its hold.
 */
export function meteredSettlement(f: SettleFacts): MeteredSettlement {
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
      costNanos: costFromTokensNanos(f.price, f.inputTokens, f.outputTokens, {
        readTokens: f.cacheReadTokens ?? null,
        writeTokens: f.cacheWriteTokens ?? null,
      }),
    };
  }
  return { reason: 'hold', costNanos: null };
}
