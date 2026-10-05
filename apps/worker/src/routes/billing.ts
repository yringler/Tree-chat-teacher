import { DomainError } from '@tangent/core';
import {
  createCheckoutRequestSchema,
  membershipWaiverRequestSchema,
  type BillingSummary,
  type CheckoutResponse,
  type MembershipInfo,
  type UsageListResponse,
} from '@tangent/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { redeemWaiverCode } from '../billing/membership.js';
import { stripePurchases } from '../billing/purchases.js';
import { getBillingSummary, listUsage } from '../billing/service.js';
import { enforceRateLimit, sameOriginOnly } from '../byok/guard.js';
import type { AppBindings } from '../env.js';
import { validateJson, validateQuery } from '../http/errors.js';

const DEFAULT_USAGE_PAGE = 50;

const usageQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Billing API, mounted at /api/billing by `worker-core`, in both modes: the
 * credit and the membership are the user's (`billingAccountId`, `userId`),
 * whichever app shows them.
 * `GET /` → BillingSummary, `GET /usage` → UsageListResponse,
 * `POST /checkout` → CheckoutResponse (credit for the user or, `target: 'pool'`,
 * for the community pool; returns to the calling app's billing page),
 * `POST /membership/waiver` → MembershipInfo (redeems MEMBERSHIP_WAIVER_CODE).
 * Subscribing and managing the membership go through the Better Auth Stripe
 * plugin (`/api/auth/subscription/*`).
 */
export function billingRoutes(): Hono<AppBindings> {
  const r = new Hono<AppBindings>();
  r.use('*', async (c, next) => {
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
    const { amountCents, target } = c.req.valid('json');
    const account = c.var.account;
    if (!account.userId) throw new DomainError('unauthorized', 'Sign in to add credit');
    const user = await c.env.DB.prepare('SELECT id, email, name FROM auth_users WHERE id = ?')
      .bind(account.userId)
      .first<{ id: string; email: string; name: string }>();
    if (!user) throw new DomainError('unauthorized', 'Sign in to add credit');
    const baseUrl = c.env.PUBLIC_BASE_URL?.trim() || new URL(c.req.url).origin;
    const body = await stripePurchases(c.env).createCheckout({
      target,
      amountCents,
      user,
      account,
      baseUrl,
    });
    return c.json(body satisfies CheckoutResponse);
  });

  // Rate limited per account before the comparison, so the code can't be brute-forced.
  r.post(
    '/membership/waiver',
    sameOriginOnly,
    validateJson(membershipWaiverRequestSchema),
    async (c) => {
      const account = c.var.account;
      if (!account.userId) throw new DomainError('unauthorized', 'Sign in to redeem a code');
      await enforceRateLimit(c, null, 'key');
      const membership = await redeemWaiverCode(c.env, account, c.req.valid('json').code);
      return c.json(membership satisfies MembershipInfo);
    },
  );

  return r;
}
