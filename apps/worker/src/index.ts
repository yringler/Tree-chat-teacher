import { DurableObject } from 'cloudflare:workers';
import { createApp } from './app.js';
import type { AppEnv } from './env.js';

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<AppEnv>;

/** Placeholder; the per-tree generation Durable Object is implemented later. */
export class TreeSession extends DurableObject<AppEnv> {}
