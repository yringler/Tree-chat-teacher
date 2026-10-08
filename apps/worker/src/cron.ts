// The Worker's cron triggers (wrangler.jsonc `triggers.crons`), dispatched on
// the cron string so each schedule runs only its own jobs.
import { pollDisputes } from './billing/payments/disputes.js';
import { reconcilePendingUsage, reconcilePoolUsage } from './billing/reconcile.js';
import type { AppEnv } from './env.js';
import { syncModelPrices } from './pool/model-prices.js';
import { accruePoolUsageShare } from './pool/revenue-share.js';

/**
 * Every 10 minutes: usage reconciliation, pool reservation expiry and the
 * balance checkpoint, the payment provider's disputes where it has to be
 * polled (billing/payments/disputes.ts), and the pool's revenue share of each
 * completed UTC day's markup (pool/revenue-share.ts; a no-op once a day is done).
 */
export const CRON_FREQUENT = '*/10 * * * *';
/** Daily 03:23 UTC: OpenRouter's list prices and model windows (pool/model-prices.ts). */
export const CRON_DAILY = '23 3 * * *';

/** The jobs, by name (the tests swap them for spies). */
export interface CronJobs {
  reconcile(env: AppEnv, now: Date): Promise<unknown>;
  poolExpiry(env: AppEnv, now: Date): Promise<unknown>;
  paymentDisputes(env: AppEnv, now: Date): Promise<unknown>;
  poolRevenueShare(env: AppEnv, now: Date): Promise<unknown>;
  priceSync(env: AppEnv, now: Date): Promise<unknown>;
}

export const CRON_JOBS: CronJobs = {
  reconcile: (env, now) => reconcilePendingUsage(env, now),
  poolExpiry: (env, now) => reconcilePoolUsage(env, now),
  paymentDisputes: (env, now) => pollDisputes(env, now),
  poolRevenueShare: (env, now) => accruePoolUsageShare(env, now),
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
      return [
        jobs.reconcile(env, now),
        jobs.poolExpiry(env, now),
        // A provider outage must never block reconciliation.
        jobs.paymentDisputes(env, now).catch((e: unknown) => {
          console.error('Payment dispute poll failed', e);
        }),
        // A failure is retried on the next run: missed days are caught up.
        jobs.poolRevenueShare(env, now).catch((e: unknown) => {
          console.error('Pool revenue share failed', e);
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
