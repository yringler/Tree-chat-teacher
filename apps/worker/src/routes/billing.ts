import { DomainError } from '@tangent/core';
import {
  createCheckoutRequestSchema,
  membershipWaiverRequestSchema,
  type BillingSummary,
  type CheckoutResponse,
  type MembershipInfo,
  type PortalResponse,
  type UsageListResponse,
} from '@tangent/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  openBillingPortal,
  redeemWaiverCode,
  startMembershipCheckout,
} from '../billing/membership.js';
import { PaymentProviderError } from '../billing/payments/index.js';
import { getBillingSummary, listUsage, startTopUpCheckout } from '../billing/service.js';
import { enforceRateLimit, sameOriginOnly } from '../byok/guard.js';
import type { AppBindings, AppContext } from '../env.js';
import { apiError, validateJson, validateQuery } from '../http/errors.js';

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
 * `POST /checkout` → CheckoutResponse (credit for the user; returns to the
 * calling app's billing page),
 * `POST /membership/waiver` → MembershipInfo (redeems MEMBERSHIP_WAIVER_CODE),
 * `POST /membership/checkout` → CheckoutResponse (the yearly membership),
 * `POST /portal` → PortalResponse (the payment provider's billing portal; 404
 * `no_customer` while it has no customer for the user). Every hosted page
 * returns to the calling app's billing page.
 */
/** The base of the URLs the payment provider sends the browser back to. */
function baseUrlOf(c: AppContext): string {
  return c.env.PUBLIC_BASE_URL?.trim() || new URL(c.req.url).origin;
}

/** A payment provider failure as 502 `provider_error`, so the UI can say "try again". */
async function viaProvider<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof PaymentProviderError)) throw err;
    console.error(JSON.stringify({ event: 'payment_provider_error', error: err.message }));
    throw new DomainError(
      'provider_error',
      "Couldn't reach the payment provider. Please try again in a moment.",
    );
  }
}

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
    const { amountCents } = c.req.valid('json');
    const account = c.var.account;
    const userId = account.userId;
    if (!userId) throw new DomainError('unauthorized', 'Sign in to add credit');
    const body = await viaProvider(() =>
      startTopUpCheckout(c.env, account, userId, amountCents, baseUrlOf(c)),
    );
    return c.json(body satisfies CheckoutResponse);
  });

  r.post('/membership/checkout', sameOriginOnly, async (c) => {
    const body = await viaProvider(() =>
      startMembershipCheckout(c.env, c.var.account, baseUrlOf(c)),
    );
    return c.json(body satisfies CheckoutResponse);
  });

  r.post('/portal', sameOriginOnly, async (c) => {
    const body = await viaProvider(() => openBillingPortal(c.env, c.var.account, baseUrlOf(c)));
    if (!body)
      return apiError(c, 'no_customer', 'There is nothing to manage yet: no payment was made.');
    return c.json(body satisfies PortalResponse);
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
