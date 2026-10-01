// Wave 1 stub (foundation). Implemented in wave 2 by the `billing` agent.
import { Hono } from 'hono';
import type { AppBindings } from '../env.js';

/**
 * Simple-account billing API, mounted at /api/billing by `worker-core`:
 * `GET /` → BillingSummary, `GET /usage` → UsageListResponse,
 * `POST /checkout` → CheckoutResponse. Power accounts get 403.
 */
export function billingRoutes(): Hono<AppBindings> {
  return new Hono<AppBindings>();
}
