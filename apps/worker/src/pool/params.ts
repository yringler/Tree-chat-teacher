// What one pool-funded request runs with, resolved Worker-side from
// `appConfig(env)` and handed to the meter and to PoolBank as arguments, so
// the Durable Objects read no pool config of their own (a per-request env,
// e.g. a test's, then applies everywhere).
import {
  appConfig,
  type ModelPrice,
  type PoolCaps,
  type PoolOverage,
  type PoolRateLimits,
} from '../config.js';
import type { AppEnv } from '../env.js';
import { simpleFastModel, simpleProviderConfig } from '../simple-mode.js';

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
  ttlMs: number;
  giveUpMs: number;
  callTimeoutMs: number;
  expireBatch: number;
  caps: PoolCaps;
  limits: PoolRateLimits;
  overage: PoolOverage;
  /** The caller's network key for per-IP caps (pool/ids.ts `ipKey`); null when unknown. */
  ipKey: string | null;
}

/** The pool model: `POOL_MODEL`, else the simple provider's fast model. */
export function poolModel(env: AppEnv): string {
  return appConfig(env).pool.model ?? simpleFastModel(env, simpleProviderConfig(env));
}

/** Resolves the pool parameters of a request from `env`. */
export function resolvePoolParams(env: AppEnv, ipKey: string | null): PoolParams {
  const config = appConfig(env);
  const pool = config.pool;
  const model = poolModel(env);
  const entry = config.prices[model];
  return {
    accountId: pool.accountId,
    model,
    price: entry ? { ...entry, feeBps: entry.feeBps ?? config.billing.openRouterFeeBps } : null,
    systemPrompt: pool.systemPrompt,
    maxInputTokens: pool.maxInputTokens,
    maxOutputTokens: pool.maxOutputTokens,
    ttlMs: pool.reservationTtlMs,
    giveUpMs: pool.giveUpMs,
    callTimeoutMs: pool.callTimeoutMs,
    expireBatch: pool.expireBatch,
    caps: pool.caps,
    limits: pool.limits,
    overage: pool.overage,
    ipKey,
  };
}
