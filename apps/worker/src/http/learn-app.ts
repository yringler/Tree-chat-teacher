// Wave 1 stub (foundation). Implemented in wave 2 by the `serving` agent.
import { Hono } from 'hono';
import type { AppBindings } from '../env.js';

/**
 * Serves the simple app under `/learn/` (PLAN §2.8), mounted at the root by
 * `worker-core`: `/learn` → 301, asset paths pass through to ASSETS, every
 * other path gets the simple app's index.html with its CSP.
 */
export function learnAppRoutes(): Hono<AppBindings> {
  return new Hono<AppBindings>();
}
