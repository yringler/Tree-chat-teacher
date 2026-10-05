import { createApp } from './app.js';
import { cronTasks } from './cron.js';
import type { AppEnv } from './env.js';

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  // Cron (wrangler.jsonc triggers.crons), dispatched on the schedule (src/cron.ts): every 10
  // minutes the usage reconciliation backstop and the community pool's expiry backstop and
  // balance checkpoint; on Mondays the pool's weekly impact snapshot.
  scheduled: (controller, env, ctx) => {
    for (const task of cronTasks(controller.cron, env, new Date(controller.scheduledTime)))
      ctx.waitUntil(task);
  },
} satisfies ExportedHandler<AppEnv>;

export { TreeSession } from './do/tree-session.js';
export { PoolBank } from './pool/pool-bank.js';
