import { createApp } from './app.js';
import { reconcilePendingUsage } from './billing/reconcile.js';
import type { AppEnv } from './env.js';

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  // Cron (wrangler.jsonc triggers.crons): usage reconciliation backstop.
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(reconcilePendingUsage(env));
  },
} satisfies ExportedHandler<AppEnv>;

export { TreeSession } from './do/tree-session.js';
