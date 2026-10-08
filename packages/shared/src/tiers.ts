import type { ModelInfo, ModelTier } from './provider.js';

/**
 * Normal and Max: the two model tiers both apps offer. Normal is the everyday
 * default; Max is a stronger model that costs many times as much. A model
 * says which tier it is through `ModelInfo.tier`, so clients never match on
 * labels, and every user-facing word about tiers comes from this file so the
 * Worker's pages, Learn and power phrase it the same way.
 */

/** Both tiers, cheaper first (the order Learn lists them in). */
export const TIERS: readonly ModelTier[] = ['normal', 'max'];

/** What each tier is called in the UI. */
export const TIER_LABELS: Readonly<Record<ModelTier, string>> = { normal: 'Normal', max: 'Max' };

/**
 * `usageFactor` to assume when a tier's list price is unknown: the factor of
 * the default models' built-in prices (DeepSeek V4.1 Flash at $0.15 / $0.60
 * per MTok against Claude Sonnet 5.5 at $2 / $10, about 14.3), which the
 * Worker's tests check against its price table.
 */
export const MAX_USAGE_FACTOR_FALLBACK = 14;

/** A model's list price, in micro-dollars per million tokens. */
export interface TokenPrice {
  inMicrosPerMTok: number;
  outMicrosPerMTok: number;
}

/**
 * Weight of input against output in `usageFactorOf`: a tutoring turn resends
 * the whole conversation, so a reply reads about ten times what it writes.
 */
const INPUT_WEIGHT = 10;

/**
 * About how many Normal replies' worth of usage one Max reply is, from the two
 * list prices: a whole number >= 1, or null when a price can't tell
 * (not finite, or a free Normal model).
 */
export function usageFactorOf(normal: TokenPrice, max: TokenPrice): number | null {
  const normalWeight = INPUT_WEIGHT * normal.inMicrosPerMTok + normal.outMicrosPerMTok;
  const maxWeight = INPUT_WEIGHT * max.inMicrosPerMTok + max.outMicrosPerMTok;
  if (!Number.isFinite(normalWeight) || !Number.isFinite(maxWeight) || normalWeight <= 0)
    return null;
  return Math.max(1, Math.round(maxWeight / normalWeight));
}

/** The first listed model of a tier. */
export function tierModel(models: readonly ModelInfo[], tier: ModelTier): ModelInfo | undefined {
  return models.find((m) => m.tier === tier);
}

/** The tier of a listed model; null when it isn't listed or isn't a tier. */
export function tierOf(
  models: readonly ModelInfo[],
  modelId: string | null | undefined,
): ModelTier | null {
  if (!modelId) return null;
  return models.find((m) => m.id === modelId)?.tier ?? null;
}

/** The note shown while Max is selected. */
export function maxUsageNote(factor: number | undefined): string {
  return factor !== undefined && factor >= 2
    ? `Max uses about ${factor}× as much as Normal.`
    : 'Max uses more than Normal.';
}

/** The note shown when comparing Normal and Max (both models answer). */
export function compareUsageNote(factor: number | undefined): string {
  return factor !== undefined && factor >= 2
    ? `Both models answer, so comparing uses about ${factor + 1}× a Normal reply. Only the answer you pick is kept.`
    : 'Both models answer, so comparing uses both models. Only the answer you pick is kept.';
}
