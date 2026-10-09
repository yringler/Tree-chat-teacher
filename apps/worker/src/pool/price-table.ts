// The price table (`model_prices`, written by the daily sync in
// model-prices.ts) and the price a model is held at (`modelPrice`, see
// model-prices.ts for which price that is): a leaf, so the pool's parameters
// and the model windows read prices without importing the sync.
import { EXPLICIT_CACHE_WRITE_MULTIPLIER, usesExplicitCacheControl } from '@tangent/providers';
import { appConfig, type ModelPrice } from '../config.js';
import type { AppEnv } from '../env.js';

/** A list price in the price table's units. */
export interface ListPrice {
  inMicrosPerMTok: number;
  outMicrosPerMTok: number;
  /** OpenRouter's `context_length`; null when not reported. */
  contextTokens: number | null;
  /** OpenRouter's `input_cache_read`; null when not listed (or unusable). */
  cacheReadMicrosPerMTok: number | null;
  /** OpenRouter's `input_cache_write`; null when not listed (or unusable). */
  cacheWriteMicrosPerMTok: number | null;
}

export interface PriceRow {
  model: string;
  in_micros_per_mtok: number;
  out_micros_per_mtok: number;
  context_tokens: number | null;
  cache_read_micros_per_mtok: number | null;
  cache_write_micros_per_mtok: number | null;
}

export function listPriceOf(row: PriceRow): ListPrice {
  return {
    inMicrosPerMTok: row.in_micros_per_mtok,
    outMicrosPerMTok: row.out_micros_per_mtok,
    contextTokens: row.context_tokens,
    cacheReadMicrosPerMTok: row.cache_read_micros_per_mtok,
    cacheWriteMicrosPerMTok: row.cache_write_micros_per_mtok,
  };
}

/** The stored (synced) price of `model`, or null when none was synced. */
export async function storedPrice(db: D1Database, model: string): Promise<ListPrice | null> {
  const row = await db
    .prepare(
      `SELECT model, in_micros_per_mtok, out_micros_per_mtok, context_tokens,
         cache_read_micros_per_mtok, cache_write_micros_per_mtok
       FROM model_prices WHERE model = ?1`,
    )
    .bind(model)
    .first<PriceRow>();
  return row ? listPriceOf(row) : null;
}

/**
 * The price `model` is held at (see the header), or null when it has no
 * configured entry. A failed D1 read falls back to the configured entry.
 */
export async function modelPrice(env: AppEnv, model: string): Promise<ModelPrice | null> {
  const config = appConfig(env);
  const entry = config.prices[model];
  if (!entry) return null;
  if (config.priceOverrides.includes(model)) return withCacheWritePrice(model, entry);
  let synced: ListPrice | null;
  try {
    synced = await storedPrice(env.DB, model);
  } catch (e) {
    console.error(`Synced price of ${model} could not be read; using the configured one`, e);
    return withCacheWritePrice(model, entry);
  }
  if (!synced) return withCacheWritePrice(model, entry);
  const price: ModelPrice = {
    ...entry,
    inMicrosPerMTok: synced.inMicrosPerMTok,
    outMicrosPerMTok: synced.outMicrosPerMTok,
    contextTokens:
      synced.contextTokens === null
        ? entry.contextTokens
        : Math.min(entry.contextTokens, synced.contextTokens),
  };
  if (synced.cacheReadMicrosPerMTok !== null)
    price.cacheReadMicrosPerMTok = synced.cacheReadMicrosPerMTok;
  if (synced.cacheWriteMicrosPerMTok !== null)
    price.cacheWriteMicrosPerMTok = synced.cacheWriteMicrosPerMTok;
  return withCacheWritePrice(model, price);
}

/**
 * `price` with a cache-write price: its own, else, for a model whose requests
 * carry explicit cache breakpoints (Anthropic's), the input price × 1.25
 * (rounded up), so holds and token-priced charges cover the write premium.
 * Other models write at the input price (or free), so they need none.
 */
export function withCacheWritePrice(model: string, price: ModelPrice): ModelPrice {
  if (price.cacheWriteMicrosPerMTok !== undefined || !usesExplicitCacheControl(model)) return price;
  return {
    ...price,
    cacheWriteMicrosPerMTok: Math.ceil(price.inMicrosPerMTok * EXPLICIT_CACHE_WRITE_MULTIPLIER),
  };
}
