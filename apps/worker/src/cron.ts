// The Worker's cron triggers (wrangler.jsonc `triggers.crons`), dispatched on
// the cron string so each schedule runs only its own jobs.
import { pollDisputes } from './billing/payments/disputes.js';
import { reconcilePendingUsage, reconcilePoolUsage } from './billing/reconcile.js';
import type { AppEnv } from './env.js';
import { aggregatePoolImpact } from './pool/impact.js';

/**
 * Every 10 minutes: usage reconciliation, pool reservation expiry and the
 * balance checkpoint, and the payment provider's disputes where it has to be
 * polled (billing/payments/disputes.ts).
 */
export const CRON_FREQUENT = '*/10 * * * *';
/** Mondays 04:17 UTC: the pool's impact snapshot of the ISO week just ended, and tag retention. */
export const CRON_WEEKLY = '17 4 * * 1';

/** The jobs, by name (the tests swap them for spies). */
export interface CronJobs {
  reconcile(env: AppEnv, now: Date): Promise<unknown>;
  poolExpiry(env: AppEnv, now: Date): Promise<unknown>;
  poolImpact(env: AppEnv, now: Date): Promise<unknown>;
  paymentDisputes(env: AppEnv, now: Date): Promise<unknown>;
}

export const CRON_JOBS: CronJobs = {
  reconcile: (env) => reconcilePendingUsage(env),
  poolExpiry: (env, now) => reconcilePoolUsage(env, now),
  poolImpact: (env, now) => aggregatePoolImpact(env, now),
  paymentDisputes: (env, now) => pollDisputes(env, now),
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
      ];
    case CRON_WEEKLY:
      return [
        jobs.poolImpact(env, now).catch((e: unknown) => {
          console.error('Pool impact aggregation failed', e);
        }),
      ];
    default:
      console.warn(JSON.stringify({ event: 'cron_unknown', cron }));
      return [];
  }
}
