import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';
import { resetBreakers } from '../src/hosted/breaker.js';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Suites share one runtime: a backend one suite's refusals opened must not reorder another's chains.
beforeEach(() => {
  resetBreakers();
});
