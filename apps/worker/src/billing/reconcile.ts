// Wave 1 stub (foundation). Implemented in wave 2 by the `billing` agent.
import type { AppEnv } from '../env.js';

/**
 * Cron backstop (`scheduled`, every 10 minutes): settles stale pending usage
 * rows via OpenRouter's generation endpoint (PLAN §2.4).
 */
export async function reconcilePendingUsage(
  _env: AppEnv,
  _now?: Date,
): Promise<{ settled: number; unresolved: number }> {
  // Neutral until implemented, so the cron trigger is harmless.
  return { settled: 0, unresolved: 0 };
}
