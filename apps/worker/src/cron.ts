// The Worker's cron triggers (wrangler.jsonc `triggers.crons`), dispatched on
// the cron string so each schedule runs only its own jobs.
import { reconcilePendingUsage, reconcilePoolUsage } from './billing/reconcile.js';
import type { AppEnv } from './env.js';
import { aggregatePoolImpact } from './pool/impact.js';
import { syncModelPrices } from './pool/model-prices.js';

/** Every 10 minutes: usage reconciliation, pool reservation expiry and the balance checkpoint. */
export const CRON_FREQUENT = '*/10 * * * *';
/** Mondays 04:17 UTC: the pool's impact snapshot of the ISO week just ended, and tag retention. */
export const CRON_WEEKLY = '17 4 * * 1';
/** Daily 03:23 UTC: OpenRouter's list prices of the priced models (pool/model-prices.ts). */
export const CRON_DAILY = '23 3 * * *';

/** The jobs, by name (the tests swap them for spies). */
export interface CronJobs {
  reconcile(env: AppEnv, now: Date): Promise<unknown>;
  poolExpiry(env: AppEnv, now: Date): Promise<unknown>;
  poolImpact(env: AppEnv, now: Date): Promise<unknown>;
  priceSync(env: AppEnv, now: Date): Promise<unknown>;
}

export const CRON_JOBS: CronJobs = {
  reconcile: (env) => reconcilePendingUsage(env),
  poolExpiry: (env, now) => reconcilePoolUsage(env, now),
  poolImpact: (env, now) => aggregatePoolImpact(env, now),
  priceSync: (env, now) => syncModelPrices(env, now),
};

/**
 * The promises `cron` starts (for `ctx.waitUntil`); none for an unknown cron,
 * which is logged (a schedule added to wrangler.jsonc without a job here).
 */
export function cronTasks(
  cron: string,
  env: AppEnv,
  now: Date,
  jobs: CronJobs = CRON_JOBS,
): Promise<unknown>[] {
  switch (cron) {
    case CRON_FREQUENT:
      return [jobs.reconcile(env, now), jobs.poolExpiry(env, now)];
    case CRON_WEEKLY:
      return [
        jobs.poolImpact(env, now).catch((e: unknown) => {
          console.error('Pool impact aggregation failed', e);
        }),
      ];
    case CRON_DAILY:
      return [
        jobs.priceSync(env, now).catch((e: unknown) => {
          console.error('Model price sync failed; the stored prices stay', e);
        }),
      ];
    default:
      console.warn(JSON.stringify({ event: 'cron_unknown', cron }));
      return [];
  }
}
