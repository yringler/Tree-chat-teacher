// Model prices: OpenRouter's list prices, synced daily by the cron into D1
// (`model_prices`), and the price a pool hold is computed from.
//
// Which price a model is held at: its explicit `MODEL_PRICES` entry (the
// operator's choice), else the synced list price, else the built-in
// placeholder (`DEFAULT_MODEL_PRICES`). Only a model with a configured entry
// is priced at all, so the sync refreshes a known model's price but never
// makes a new model usable by the pool. The context window is the lower of
// the configured one and OpenRouter's: a smaller window only makes the pool
// refuse more requests (`poolInputLimitTokens`), and the ceiling hold stays small.
// The sync also stores every other listed model's price, which only Tangent
// credit reads (`creditPrice`): credit takes any OpenRouter model, and holds
// each call at its own model's price.
//
// Safety: a price increase is applied whatever its size (holds only grow, so
// the pool refuses earlier rather than overspending). A drop to under
// 1/`MAX_PRICE_DROP_FACTOR` of the stored price is held back and logged
// (`price_sync_anomaly`): a bogus low price would make holds smaller than real
// costs and trip the overage breaker. An operator who confirms such a drop
// sets it in `MODEL_PRICES`. A failed fetch, or a model missing from the list,
// keeps the stored price.
//
// Prompt caching: the sync also stores OpenRouter's cache prices
// (`input_cache_read`, `input_cache_write`) when listed. Like the input and
// output prices, a synced cache price replaces the built-in placeholder's, and
// an explicit `MODEL_PRICES` entry wins over both. A cache price neither gives
// falls back: a write to 1.25× the input price on explicit-cache (Anthropic)
// models (`withCacheWritePrice`), else the input price; a read to the input
// price. They only matter for holds and token-priced settlements: a reported
// or looked-up cost already includes them. A cache price that drops to under
// 1/`MAX_PRICE_DROP_FACTOR` of the stored one is held back like the others.
import { DomainError } from '@tangent/core';
import { appConfig, type ModelPrice } from '../config.js';
import type { AppEnv } from '../env.js';
import { syncModelWindows } from '../model-windows.js';
import { isOpenRouter, simpleProviderConfig } from '../simple-mode.js';
import { poolModel } from './params.js';
import {
  listPriceOf,
  modelPrice,
  storedPrice,
  withCacheWritePrice,
  type ListPrice,
  type PriceRow,
} from './price-table.js';
import { logEvent } from '../log.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
/** A synced price below 1/this of the stored one is held back as an anomaly. */
export const MAX_PRICE_DROP_FACTOR = 10;
const FETCH_TIMEOUT_MS = 15_000;
/** USD per token × 10¹² = micro-USD per million tokens. */
const SCALE_DIGITS = 12;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * OpenRouter's USD-per-token decimal string (`"0.000002"`) in micro-USD per
 * million tokens (`2000000`), exactly: decimal digits shifted in BigInt, not
 * float math, and rounded up past the 12th decimal (in the pool's favour).
 * Null for anything else, including the `"-1"` of variably priced routers.
 */
export function usdPerTokenToMicrosPerMTok(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) return null;
  const whole = m[1] as string;
  const frac = m[2] ?? '';
  const kept = frac.slice(0, SCALE_DIGITS).padEnd(SCALE_DIGITS, '0');
  let micros = BigInt(whole) * 10n ** BigInt(SCALE_DIGITS) + BigInt(kept);
  if (/[1-9]/.test(frac.slice(SCALE_DIGITS))) micros += 1n;
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

/**
 * The list prices in a `GET /api/v1/models` body, by model id; null for a
 * listed model whose input or output price is unusable (an unusable cache
 * price is just null). Throws on a body without `data`.
 */
export function parseListPrices(body: unknown): Map<string, ListPrice | null> {
  const data = isRecord(body) ? body['data'] : undefined;
  if (!Array.isArray(data)) throw new Error('OpenRouter models list has no data array');
  const prices = new Map<string, ListPrice | null>();
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry['id'] !== 'string') continue;
    const pricing = entry['pricing'];
    const inMicros = isRecord(pricing) ? usdPerTokenToMicrosPerMTok(pricing['prompt']) : null;
    const outMicros = isRecord(pricing) ? usdPerTokenToMicrosPerMTok(pricing['completion']) : null;
    const context = entry['context_length'];
    prices.set(
      entry['id'],
      inMicros === null || outMicros === null
        ? null
        : {
            inMicrosPerMTok: inMicros,
            outMicrosPerMTok: outMicros,
            contextTokens:
              typeof context === 'number' && Number.isSafeInteger(context) && context > 0
                ? context
                : null,
            cacheReadMicrosPerMTok: usdPerTokenToMicrosPerMTok(
              isRecord(pricing) ? pricing['input_cache_read'] : undefined,
            ),
            cacheWriteMicrosPerMTok: usdPerTokenToMicrosPerMTok(
              isRecord(pricing) ? pricing['input_cache_write'] : undefined,
            ),
          },
    );
  }
  return prices;
}

/** `GET /api/v1/models` (public, no key), its body as JSON. Throws on network failure or non-2xx. */
export async function fetchModelsList(
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<unknown> {
  const res = await fetchImpl(OPENROUTER_MODELS_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`OpenRouter models list failed: HTTP ${res.status}`);
  }
  return res.json();
}

/** How long a completed on-demand sync stands before a miss runs another (`creditPrice`). */
const ON_DEMAND_SYNC_FRESH_MS = 10 * 60_000;
/** How long a failed one stands: a miss soon after asks OpenRouter again. */
const ON_DEMAND_RETRY_MS = 60_000;
/** This isolate's latest on-demand sync: concurrent misses share it. */
let onDemandSync: { at: number; ok: Promise<boolean> } | null = null;

/**
 * Runs the price sync now, unless this isolate ran one recently (shared by
 * concurrent callers), when the built-in provider is OpenRouter, the only
 * endpoint the sync lists. Resolves whether OpenRouter's list was read
 * (true where there is nothing to read). Never throws.
 */
async function syncOnDemand(env: AppEnv): Promise<boolean> {
  let openRouter: boolean;
  try {
    openRouter = isOpenRouter(simpleProviderConfig(env).baseUrl);
  } catch {
    return true;
  }
  if (!openRouter) return true;
  const now = Date.now();
  const last = onDemandSync;
  const stale =
    !last ||
    now - last.at >= ON_DEMAND_SYNC_FRESH_MS ||
    (now - last.at >= ON_DEMAND_RETRY_MS && !(await last.ok));
  if (stale) {
    onDemandSync = {
      at: now,
      ok: syncModelPrices(env, new Date(now)).then(
        () => true,
        (e: unknown) => {
          logEvent('error', 'price_sync_failed', { onDemand: true, error: e });
          return false;
        },
      ),
    };
  }
  return onDemandSync!.ok;
}

/**
 * The price a Tangent credit call on `model` is held at (billing/personal-meter.ts):
 * `modelPrice` for a configured model (every model the product offers has
 * one, built in or in `MODEL_PRICES`), else the list price the sync stored
 * for it (it stores every listed model's), or null when OpenRouter lists no
 * price for it, so the model can't run on credit. A model the store doesn't
 * know yet (before the first daily sync after a deploy, or listed since)
 * syncs on demand; when OpenRouter can't be read then, a 502
 * `provider_error` is thrown rather than calling the model unpriced. A
 * stored price without a window has none.
 */
export async function creditPrice(env: AppEnv, model: string): Promise<ModelPrice | null> {
  const configured = await modelPrice(env, model);
  if (configured) return configured;
  let synced = await storedPrice(env.DB, model);
  if (!synced) {
    const read = await syncOnDemand(env);
    synced = await storedPrice(env.DB, model);
    if (!synced && !read) {
      throw new DomainError(
        'provider_error',
        `The price of ${model} couldn't be looked up just now. Try again in a moment.`,
      );
    }
  }
  if (!synced) return null;
  const price: ModelPrice = {
    inMicrosPerMTok: synced.inMicrosPerMTok,
    outMicrosPerMTok: synced.outMicrosPerMTok,
    contextTokens: synced.contextTokens ?? Number.MAX_SAFE_INTEGER,
  };
  if (synced.cacheReadMicrosPerMTok !== null)
    price.cacheReadMicrosPerMTok = synced.cacheReadMicrosPerMTok;
  if (synced.cacheWriteMicrosPerMTok !== null)
    price.cacheWriteMicrosPerMTok = synced.cacheWriteMicrosPerMTok;
  return withCacheWritePrice(model, price);
}

/** The models the sync tracks: every configured price, and the pool model. */
export function trackedModels(env: AppEnv): string[] {
  return [...new Set([...Object.keys(appConfig(env).prices), poolModel(env)])];
}

/** Whether `next` is under 1/`MAX_PRICE_DROP_FACTOR` of `prev` (both known). */
function droppedTooFar(prev: number | null, next: number | null): boolean {
  return prev !== null && next !== null && next * MAX_PRICE_DROP_FACTOR < prev;
}

/**
 * Whether `next` drops any price (input, output, or a cache price both list)
 * to under 1/`MAX_PRICE_DROP_FACTOR` of `prev`.
 */
export function isAnomalousDrop(prev: ListPrice, next: ListPrice): boolean {
  return (
    droppedTooFar(prev.inMicrosPerMTok, next.inMicrosPerMTok) ||
    droppedTooFar(prev.outMicrosPerMTok, next.outMicrosPerMTok) ||
    droppedTooFar(prev.cacheReadMicrosPerMTok, next.cacheReadMicrosPerMTok) ||
    droppedTooFar(prev.cacheWriteMicrosPerMTok, next.cacheWriteMicrosPerMTok)
  );
}

function samePrice(a: ListPrice, b: ListPrice): boolean {
  return (
    a.inMicrosPerMTok === b.inMicrosPerMTok &&
    a.outMicrosPerMTok === b.outMicrosPerMTok &&
    a.contextTokens === b.contextTokens &&
    a.cacheReadMicrosPerMTok === b.cacheReadMicrosPerMTok &&
    a.cacheWriteMicrosPerMTok === b.cacheWriteMicrosPerMTok
  );
}

/** Whether an override prices any of input, output or a listed cache price below the list. */
function isBelowList(override: ModelPrice, listed: ListPrice): boolean {
  const below = (own: number | undefined, list: number | null) =>
    own !== undefined && list !== null && own < list;
  return (
    override.inMicrosPerMTok < listed.inMicrosPerMTok ||
    override.outMicrosPerMTok < listed.outMicrosPerMTok ||
    below(override.cacheReadMicrosPerMTok, listed.cacheReadMicrosPerMTok) ||
    below(override.cacheWriteMicrosPerMTok, listed.cacheWriteMicrosPerMTok)
  );
}

/** The stored columns of `model`'s list price, in table order (before the timestamp). */
function priceColumns(model: string, p: ListPrice): (string | number | null)[] {
  return [
    model,
    p.inMicrosPerMTok,
    p.outMicrosPerMTok,
    p.contextTokens,
    p.cacheReadMicrosPerMTok,
    p.cacheWriteMicrosPerMTok,
  ];
}

export interface PriceSyncResult {
  /** New or changed prices, written (and added to the history). */
  changed: string[];
  /** Prices the list confirmed as stored. */
  unchanged: string[];
  /** Not listed, or listed without a usable price: the stored price stays. */
  missing: string[];
  /** Held back (`isAnomalousDrop`): the stored price stays. */
  anomalies: string[];
}

/** D1 binds at most 100 parameters a statement; seven per price row. */
const PRICE_ROWS_PER_INSERT = 14;

/** Every stored price, by model. */
async function storedPrices(db: D1Database): Promise<Map<string, ListPrice>> {
  const { results } = await db
    .prepare(
      `SELECT model, in_micros_per_mtok, out_micros_per_mtok, context_tokens,
         cache_read_micros_per_mtok, cache_write_micros_per_mtok
       FROM model_prices`,
    )
    .all<PriceRow>();
  return new Map(results.map((row) => [row.model, listPriceOf(row)]));
}

/**
 * Stores the list prices of the models the sync doesn't track, for Tangent
 * credit's holds (`creditPrice`): new and changed rows only (a few hundred
 * models, most unchanged from day to day), in multi-row statements, with the
 * same hold-back of a collapsed price but no history and no per-model logs.
 * Returns how many were written.
 */
async function syncUntrackedPrices(
  env: AppEnv,
  list: Map<string, ListPrice | null>,
  tracked: ReadonlySet<string>,
  at: string,
): Promise<number> {
  const stored = await storedPrices(env.DB);
  const rows: (string | number | null)[][] = [];
  const anomalies: string[] = [];
  for (const [model, next] of list) {
    if (!next || tracked.has(model)) continue;
    const prev = stored.get(model);
    if (prev && samePrice(prev, next)) continue;
    if (prev && isAnomalousDrop(prev, next)) {
      anomalies.push(model);
      continue;
    }
    rows.push([...priceColumns(model, next), at]);
  }
  if (anomalies.length > 0) {
    // One line for all of them: a list-wide glitch would otherwise log hundreds.
    logEvent('error', 'price_sync_anomaly', { models: anomalies });
  }
  const writes: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += PRICE_ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + PRICE_ROWS_PER_INSERT);
    writes.push(
      env.DB.prepare(
        `INSERT INTO model_prices (model, in_micros_per_mtok, out_micros_per_mtok, context_tokens,
           cache_read_micros_per_mtok, cache_write_micros_per_mtok, fetched_at)
         VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}
         ON CONFLICT (model) DO UPDATE SET in_micros_per_mtok = excluded.in_micros_per_mtok,
           out_micros_per_mtok = excluded.out_micros_per_mtok,
           context_tokens = excluded.context_tokens,
           cache_read_micros_per_mtok = excluded.cache_read_micros_per_mtok,
           cache_write_micros_per_mtok = excluded.cache_write_micros_per_mtok,
           fetched_at = excluded.fetched_at`,
      ).bind(...chunk.flat()),
    );
  }
  if (writes.length > 0) await env.DB.batch(writes);
  return rows.length;
}

/**
 * The daily price sync: fetches OpenRouter's list prices and stores those of
 * the tracked models (see the header for what is held back), then those of
 * every other listed model (`syncUntrackedPrices`). Throws when the list
 * can't be fetched or D1 can't be written; no tracked price is stored then.
 * From the same list it then stores every model's context window
 * (model-windows.ts `syncModelWindows`); a failure there, or in the other
 * models' prices, is logged and leaves the tracked prices stored.
 */
export async function syncModelPrices(
  env: AppEnv,
  now: Date,
  fetchImpl?: typeof fetch,
): Promise<PriceSyncResult> {
  const config = appConfig(env);
  const models = trackedModels(env);
  const body = await fetchModelsList(fetchImpl);
  const list = parseListPrices(body);
  const at = now.toISOString();
  const result: PriceSyncResult = { changed: [], unchanged: [], missing: [], anomalies: [] };
  const writes: D1PreparedStatement[] = [];

  for (const model of models) {
    const next = list.get(model);
    if (!next) {
      result.missing.push(model);
      logEvent('warn', 'price_sync_missing', { model });
      continue;
    }
    const prev = await storedPrice(env.DB, model);
    if (prev && isAnomalousDrop(prev, next)) {
      result.anomalies.push(model);
      logEvent('error', 'price_sync_anomaly', { model, stored: prev, listed: next });
      continue;
    }
    // An override below the list price under-holds: real costs exceed the holds.
    const override = config.priceOverrides.includes(model) ? config.prices[model] : undefined;
    if (override && isBelowList(override, next)) {
      logEvent('warn', 'price_override_below_list', { model, override, listed: next });
    }
    const changed = !prev || !samePrice(prev, next);
    (changed ? result.changed : result.unchanged).push(model);
    writes.push(
      env.DB.prepare(
        `INSERT INTO model_prices (model, in_micros_per_mtok, out_micros_per_mtok, context_tokens,
           cache_read_micros_per_mtok, cache_write_micros_per_mtok, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (model) DO UPDATE SET in_micros_per_mtok = excluded.in_micros_per_mtok,
           out_micros_per_mtok = excluded.out_micros_per_mtok,
           context_tokens = excluded.context_tokens,
           cache_read_micros_per_mtok = excluded.cache_read_micros_per_mtok,
           cache_write_micros_per_mtok = excluded.cache_write_micros_per_mtok,
           fetched_at = excluded.fetched_at`,
      ).bind(...priceColumns(model, next), at),
    );
    if (changed && prev) logEvent('warn', 'price_changed', { model, from: prev, to: next });
  }

  if (writes.length > 0) await env.DB.batch(writes);
  const others = await syncUntrackedPrices(env, list, new Set(models), at).catch((e: unknown) => {
    logEvent('error', 'price_sync_failed', { untracked: true, error: e });
    return 0;
  });
  logEvent('info', 'price_sync', { ...result, others });
  await syncModelWindows(env, now, body).catch((e: unknown) => {
    logEvent('error', 'window_sync_failed', { error: e });
  });
  return result;
}
