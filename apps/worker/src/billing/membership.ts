// The yearly membership (PLAN §2.3, §13): required to generate in either app
// once ANNUAL_FEE_ENABLED is "true" and billing and STRIPE_MEMBERSHIP_PRICE_ID
// are configured (docs/pool/PLAN.md S7; the flag ships off, gating, not
// deleting, everything below). It is the one
// plan of the Better Auth Stripe plugin (auth/auth.ts), whose `auth_subscriptions`
// row tells whether it is paid; `auth_users.membership_waived` lets the
// operator waive the fee per user, and wins over Stripe.
import { DomainError, MembershipRequiredError } from '@tangent/core';
import { MEMBERSHIP_PLAN, type MembershipInfo } from '@tangent/shared';
import type { AccountContext, AppEnv } from '../env.js';
import { builtInAvailable } from '../services.js';
import { appConfig } from '../config.js';
import { billingConfigured, membershipPriceId } from './stripe.js';

export { DEFAULT_MEMBERSHIP_CREDIT_CENTS, DEFAULT_MEMBERSHIP_PRICE_CENTS } from '../config.js';

/**
 * Subscription statuses that count as a paid membership. `past_due` does:
 * Stripe keeps retrying a failed renewal for days, and the member shouldn't be
 * locked out meanwhile. `canceled`, `unpaid` and `incomplete*` don't.
 */
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

/**
 * True when generating needs a membership: the annual fee is on
 * (`ANNUAL_FEE_ENABLED`) and billing and the membership price are configured.
 * Off, `MembershipInfo.required` is false, which hides every gate in the apps.
 */
export function membershipRequired(env: AppEnv): boolean {
  return (
    appConfig(env).flags.annualFeeEnabled &&
    billingConfigured(env) &&
    membershipPriceId(env) !== null
  );
}

/** The yearly price shown to users (`MEMBERSHIP_PRICE_CENTS`; Stripe charges the configured price). */
export function membershipPriceCents(env: AppEnv): number {
  return appConfig(env).billing.membershipPriceCents;
}

/**
 * Credit included with each paid membership invoice, in cents: `MEMBERSHIP_CREDIT_CENTS`,
 * or 0 when the server doesn't offer the built-in provider (nothing to spend it on,
 * so nothing is promised or granted).
 */
export function membershipCreditCents(env: AppEnv): number {
  if (!builtInAvailable(env)) return 0;
  return appConfig(env).billing.membershipCreditCentsRaw;
}

interface MembershipRow {
  waived: number;
  status: string | null;
  period_end: number | null;
  cancel_at_period_end: number | null;
}

/**
 * The user's membership. One query (the user's waiver flag joined with their
 * most relevant membership subscription: a paid one first, then the latest
 * period), skipped entirely when no membership is required, including the dev
 * bypass (no user).
 */
export async function membershipFor(env: AppEnv, account: AccountContext): Promise<MembershipInfo> {
  const base: MembershipInfo = {
    required: false,
    status: 'inactive',
    stripeStatus: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: membershipPriceCents(env),
    includedCreditCents: membershipCreditCents(env),
  };
  if (!account.userId || !membershipRequired(env)) return base;
  const active = ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ');
  const row = await env.DB.prepare(
    `SELECT u.membership_waived AS waived, s.status, s.period_end, s.cancel_at_period_end
     FROM auth_users u
     LEFT JOIN auth_subscriptions s
       ON s.reference_id = u.id AND s.plan = ?2
       AND s.status NOT IN ('incomplete', 'incomplete_expired')
     WHERE u.id = ?1
     ORDER BY (s.status IN (${active})) DESC, COALESCE(s.period_end, 0) DESC
     LIMIT 1`,
  )
    .bind(account.userId, MEMBERSHIP_PLAN)
    .first<MembershipRow>();
  const stripeStatus = row?.status ?? null;
  const paid = stripeStatus !== null && ACTIVE_STATUSES.includes(stripeStatus);
  return {
    ...base,
    required: true,
    status: row?.waived ? 'waived' : paid ? 'active' : 'inactive',
    stripeStatus,
    periodEnd: row?.period_end == null ? null : new Date(row.period_end).toISOString(),
    cancelAtPeriodEnd: !!row?.cancel_at_period_end,
  };
}

/**
 * Throws `MembershipRequiredError` (402 `membership_required`) when the
 * membership is required and the user has neither paid nor been waived. Only
 * the routes that generate call it: reading, exporting, deleting and settings
 * stay open, so nobody is locked out of their data.
 */
export async function assertMember(env: AppEnv, account: AccountContext): Promise<void> {
  const membership = await membershipFor(env, account);
  if (membership.required && membership.status === 'inactive') throw new MembershipRequiredError();
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * Compares a redeemed code with MEMBERSHIP_WAIVER_CODE in constant time. Both
 * are hashed first, so the comparison runs over two equal-length digests,
 * touching every byte, and leaks neither the code's contents nor its length.
 * (workerd's `crypto.subtle.timingSafeEqual` would do the same, but the test
 * types don't declare it.)
 */
async function codeMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Redeems the operator's waiver code: on a match, sets the user's
 * `membership_waived` flag (keeping the time it was first set) and returns the
 * resulting membership. 400 when no code is configured, 403 on a wrong code.
 * The caller rate-limits (the code is guessable only by brute force).
 */
export async function redeemWaiverCode(
  env: AppEnv,
  account: AccountContext,
  code: string,
): Promise<MembershipInfo> {
  if (!account.userId) throw new DomainError('unauthorized', 'Sign in to redeem a code');
  const expected = env.MEMBERSHIP_WAIVER_CODE?.trim();
  if (!expected) throw new DomainError('bad_request', 'Membership codes are not offered here');
  if (!(await codeMatches(code.trim(), expected)))
    throw new DomainError('forbidden', 'That code is not valid');
  await env.DB.prepare(
    `UPDATE auth_users
     SET membership_waived_at = CASE WHEN membership_waived = 1 THEN membership_waived_at ELSE ?2 END,
         membership_waived = 1
     WHERE id = ?1`,
  )
    .bind(account.userId, new Date().toISOString())
    .run();
  return membershipFor(env, account);
}
