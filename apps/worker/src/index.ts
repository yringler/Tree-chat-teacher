import { createApp } from './app.js';
import type { AppEnv } from './env.js';

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<AppEnv>;

export { TreeSession } from './do/tree-session.js';
