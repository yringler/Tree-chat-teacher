// What one pool-funded request runs with, resolved Worker-side from
// `appConfig(env)` and handed to the meter and to PoolBank as arguments, so
// the Durable Objects read no pool config of their own (a per-request env,
// e.g. a test's, then applies everywhere).
import type { PoolBlockDetails, ReasoningEffort, UsagePurpose } from '@tangent/shared';
import {
  appConfig,
  backgroundEffort,
  DEFAULT_TIER_REQUESTS,
  withTierDefaults,
  type ModelPrice,
  type PoolCaps,
  type PoolConfig,
  type PoolOverage,
  type PoolRateLimits,
  type TierRequestConfig,
} from '../config.js';
import type { AppEnv } from '../env.js';
import { simpleFastModel, simpleProviderConfig } from '../simple-mode.js';
import { modelPrice, withCacheWritePrice } from './model-prices.js';
import type { PoolAdmitRequest, PoolRefusal, PoolReserveRequest } from './pool-bank.js';
import { ceilingHoldMicros } from './pricing.js';

export interface PoolParams {
  /** The pool's ledger account id (`POOL_ACCOUNT_ID`). */
  accountId: string;
  /** The one model pool calls use; every pool hold is priced for it. */
  model: string;
  /** Its price entry with `feeBps` filled in; null = not priced, so the pool refuses (`unpriced`). */
  price: (ModelPrice & { feeBps: number }) | null;
  systemPrompt: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** The pool model's reasoning effort (`POOL_EFFORT`, else the default model's); null = its default. */
  effort: ReasoningEffort | null;
  /** OpenRouter providers pinned for the pool model (`POOL_PROVIDER_ORDER`, else the default model's). */
  providerOrder: readonly string[];
  /** The effort of the pool's summaries and titles (`backgroundEffort`); null = `effort`. */
  summaryEffort: ReasoningEffort | null;
  /** The longest message a pool send accepts (`POOL_MAX_MESSAGE_CHARS`). */
  maxMessageChars: number;
  ttlMs: number;
  giveUpMs: number;
  callTimeoutMs: number;
  expireBatch: number;
  caps: PoolCaps;
  limits: PoolRateLimits;
  overage: PoolOverage;
  /** The caller's network key for per-IP caps (pool/ids.ts `ipKey`); null when unknown. */
  ipKey: string | null;
  /** The pool notice version the caller must have acknowledged (pool/consent.ts). */
  noticeVersion: number;
}

/** The pool model: `POOL_MODEL`, else Learn's background model (`simpleFastModel`, SIMPLE_FAST_MODEL). */
export function poolModel(env: AppEnv): string {
  return appConfig(env).pool.model ?? simpleFastModel(env, simpleProviderConfig(env));
}

/**
 * How the pool asks `model` (its model, `poolModel`): `POOL_EFFORT` and
 * `POOL_PROVIDER_ORDER`, else the default pool model's evaluated settings
 * while it runs that model (`withTierDefaults`). The reply cap is
 * `POOL_MAX_OUTPUT_TOKENS`, apart.
 */
export function poolRequest(
  env: AppEnv,
  model: string = poolModel(env),
): Pick<TierRequestConfig, 'effort' | 'providerOrder'> {
  const pool = appConfig(env).pool;
  const { effort, providerOrder } = withTierDefaults(
    { effort: pool.effort, maxOutputTokens: null, providerOrder: pool.providerOrder },
    DEFAULT_TIER_REQUESTS.pool,
    model,
  );
  return { effort, providerOrder };
}

/**
 * Resolves the pool parameters of a request from `env` (the price: `modelPrice`).
 * The caps are the same for every caller: nothing here depends on who asks
 * but their network (`ipKey`).
 */
export async function resolvePoolParams(env: AppEnv, ipKey: string | null): Promise<PoolParams> {
  const config = appConfig(env);
  const pool = config.pool;
  const model = poolModel(env);
  const entry = await modelPrice(env, model);
  const request = poolRequest(env, model);
  const price = entry
    ? { ...entry, feeBps: entry.feeBps ?? config.billing.openRouterFeeBps }
    : null;
  return {
    accountId: pool.accountId,
    model,
    // A price whose reply ceiling no cap admits refuses as `unpriced` (logged), not as the user's cap.
    price: price && reportCeilingProblem(pool, model, price) === null ? price : null,
    systemPrompt: pool.systemPrompt,
    maxInputTokens: pool.maxInputTokens,
    maxOutputTokens: pool.maxOutputTokens,
    effort: request.effort,
    providerOrder: request.providerOrder,
    summaryEffort: backgroundEffort(env, model),
    maxMessageChars: pool.maxMessageChars,
    ttlMs: pool.reservationTtlMs,
    giveUpMs: pool.giveUpMs,
    callTimeoutMs: pool.callTimeoutMs,
    expireBatch: pool.expireBatch,
    caps: pool.caps,
    limits: pool.limits,
    overage: pool.overage,
    ipKey,
    noticeVersion: pool.noticeVersion,
  };
}

/** A pool reply's hold before its prompt exists: `ceilingHoldMicros` at the pool's caps. */
export function replyCeilingMicros(
  pool: Pick<PoolParams, 'maxInputTokens' | 'maxOutputTokens'>,
  price: ModelPrice & { feeBps: number },
): number {
  return ceilingHoldMicros(price, pool.maxInputTokens, pool.maxOutputTokens, price.feeBps);
}

/**
 * Why the pool can reserve no reply at `price`, or null. PoolBank refuses a
 * hold that would take a day's spend over a cap, so a reply ceiling above
 * the per-user, per-network or fixed global daily cap refuses every reply,
 * each one looking like a user who hit their cap.
 */
function ceilingProblem(
  pool: Pick<PoolConfig, 'maxInputTokens' | 'maxOutputTokens' | 'caps'>,
  model: string,
  price: ModelPrice & { feeBps: number },
): string | null {
  const hold = replyCeilingMicros(pool, price);
  const caps: [string, number][] = [
    ['POOL_SPEND_MICROS_PER_DAY', pool.caps.user.spendMicrosPerDay],
    ['POOL_IP_SPEND_MICROS_PER_DAY', pool.caps.ip.spendMicrosPerDay],
    ['POOL_DAILY_GLOBAL_MICROS', pool.caps.global.spendMicrosPerDay],
  ];
  const over = caps.find(([, cap]) => hold > cap);
  if (!over) return null;
  return (
    `A pool reply's ceiling hold (${hold} µ$: POOL_MAX_INPUT_TOKENS in and POOL_MAX_OUTPUT_TOKENS ` +
    `out at ${model}'s price) is above ${over[0]} (${over[1]} µ$), so the pool would refuse ` +
    'every reply. Lower those token caps or raise the spend caps.'
  );
}

/** Problems already logged by this isolate (each once). */
const reported = new Set<string>();

/** `ceilingProblem`, logged as an error the first time this isolate sees it. */
function reportCeilingProblem(
  pool: PoolConfig,
  model: string,
  price: ModelPrice & { feeBps: number },
): string | null {
  const problem = ceilingProblem(pool, model, price);
  if (problem !== null && !reported.has(problem)) {
    reported.add(problem);
    console.error(JSON.stringify({ event: 'pool_misconfigured', problem }));
  }
  return problem;
}

/**
 * Why the pool cannot serve replies as configured (`ceilingProblem` at the
 * pool model's configured price), or null; also null for an unpriced model,
 * which the pool refuses on its own (`unpriced`). Read synchronously, so
 * `poolAvailable` reports such a pool as off instead of refusing each reply.
 */
export function poolConfigProblem(env: AppEnv): string | null {
  const config = appConfig(env);
  const model = poolModel(env);
  const entry = config.prices[model];
  if (!entry) return null;
  const price = withCacheWritePrice(model, entry);
  return reportCeilingProblem(config.pool, model, {
    ...price,
    feeBps: price.feeBps ?? config.billing.openRouterFeeBps,
  });
}

/**
 * `poolConfigProblem` at the price pool holds are actually priced at
 * (`modelPrice`: the synced price unless `MODEL_PRICES` pins one), which
 * `resolvePoolParams` refuses on: what the pool's own reports read
 * (pool/status.ts `poolUsable`), so they never say "on" while every reply is
 * refused.
 */
export async function poolPriceProblem(env: AppEnv): Promise<string | null> {
  const config = appConfig(env);
  const model = poolModel(env);
  const entry = await modelPrice(env, model);
  if (!entry) return null;
  return reportCeilingProblem(config.pool, model, {
    ...entry,
    feeBps: entry.feeBps ?? config.billing.openRouterFeeBps,
  });
}

/** One call to reserve for on the pool (see `poolReserveRequest`). */
export interface PoolCall {
  purpose: UsagePurpose;
  treeId: string | null;
  branchId: string | null;
  nodeId: string | null;
  providerId: string;
  /** Worst-case cost of the call, micro-USD. */
  holdMicros: number;
  feeBps: number;
}

/** The `PoolBank.reserve` request of `userId`'s `call`, with the pool's caps and expiry. */
export function poolReserveRequest(
  pool: PoolParams,
  userId: string,
  call: PoolCall,
): PoolReserveRequest {
  return {
    poolId: pool.accountId,
    userId,
    ipKey: pool.ipKey,
    model: pool.model,
    ...call,
    caps: pool.caps,
    limits: pool.limits,
    overage: pool.overage,
    expiry: { ttlMs: pool.ttlMs, giveUpMs: pool.giveUpMs, batch: pool.expireBatch },
  };
}

/** The `PoolBank.admit` request of `userId` (a context resolve), with the pool's limits. */
export function poolAdmitRequest(pool: PoolParams, userId: string): PoolAdmitRequest {
  return {
    poolId: pool.accountId,
    userId,
    ipKey: pool.ipKey,
    limits: pool.limits,
    overage: pool.overage,
  };
}

/** What a refused reservation tells the client (`ApiError.error.pool`). */
export function poolBlockDetails(refusal: PoolRefusal): PoolBlockDetails {
  const { reason, limit, resetAt } = refusal;
  return { reason, limit, resetAt };
}
