import { DomainError } from '@tangent/core';
import {
  createCheckoutRequestSchema,
  type BillingSummary,
  type CheckoutResponse,
  type UsageListResponse,
} from '@tangent/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { createCreditCheckout, getBillingSummary, listUsage } from '../billing/service.js';
import { sameOriginOnly } from '../byok/guard.js';
import type { AppBindings } from '../env.js';
import { validateJson, validateQuery } from '../http/errors.js';

const DEFAULT_USAGE_PAGE = 50;

const usageQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Simple-account billing API, mounted at /api/billing by `worker-core`:
 * `GET /` → BillingSummary, `GET /usage` → UsageListResponse,
 * `POST /checkout` → CheckoutResponse. Power accounts get 403.
 */
export function billingRoutes(): Hono<AppBindings> {
  const r = new Hono<AppBindings>();
  r.use('*', async (c, next) => {
    if (c.var.account.mode !== 'simple') {
      throw new DomainError('forbidden', 'Billing is only available for personal accounts');
    }
    await next();
    c.header('Cache-Control', 'no-store');
  });

  r.get('/', async (c) =>
    c.json((await getBillingSummary(c.env, c.var.account)) satisfies BillingSummary),
  );

  r.get('/usage', validateQuery(usageQuerySchema), async (c) => {
    const { cursor, limit } = c.req.valid('query');
    const page = await listUsage(c.env, c.var.account, cursor ?? null, limit ?? DEFAULT_USAGE_PAGE);
    return c.json(page satisfies UsageListResponse);
  });

  r.post('/checkout', sameOriginOnly, validateJson(createCheckoutRequestSchema), async (c) => {
    const { amountCents } = c.req.valid('json');
    const account = c.var.account;
    if (!account.userId) throw new DomainError('unauthorized', 'Sign in to add credit');
    const user = await c.env.DB.prepare('SELECT id, email, name FROM auth_users WHERE id = ?')
      .bind(account.userId)
      .first<{ id: string; email: string; name: string }>();
    if (!user) throw new DomainError('unauthorized', 'Sign in to add credit');
    const baseUrl = c.env.PUBLIC_BASE_URL?.trim() || new URL(c.req.url).origin;
    const body = await createCreditCheckout(c.env, account, user, amountCents, baseUrl);
    return c.json(body satisfies CheckoutResponse);
  });

  return r;
}
