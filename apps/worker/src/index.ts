import { createApp } from './app.js';
import { reconcilePendingUsage, reconcilePoolUsage } from './billing/reconcile.js';
import type { AppEnv } from './env.js';

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  // Cron (wrangler.jsonc triggers.crons): usage reconciliation backstop, and the community
  // pool's expiry backstop and balance checkpoint.
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(reconcilePendingUsage(env));
    ctx.waitUntil(reconcilePoolUsage(env));
  },
} satisfies ExportedHandler<AppEnv>;

export { TreeSession } from './do/tree-session.js';
export { PoolBank } from './pool/pool-bank.js';
