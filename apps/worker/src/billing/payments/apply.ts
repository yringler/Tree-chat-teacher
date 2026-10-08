// The domain side of payments (03-architecture.md §2.3): what each normalised
// `PaymentEvent` does to the ledger, the open pool and the membership.
// Provider-independent: adapters (billing/providers/*) turn deliveries and
// polls into events, and this module decides. Every write is idempotent on a
// provider ref (`credit_grants.provider_ref`) or guarded by a version
// (`billing_subscriptions`), so redeliveries, duplicates and any order of
// events are safe:
//
// - payment.succeeded, credits → `fulfilPurchase` (the buyer's own credit,
//   net of the processing fee), once per payment ref. Non-USD payments,
//   unknown targets (a legacy pool purchase) and any ledger but a personal one
//   are logged and never credited; an unknown fee throws RetryLaterError.
// - payment.succeeded, membership (first year or renewal) → the included
//   credit (MEMBERSHIP_CREDIT_CENTS), a fixed gift with no gross or fee, once
//   per payment.
// - refund.succeeded → a personal purchase: − the refunded pre-tax amount in
//   full (the processor keeps its fee, so the refund passes it on); a legacy
//   pool purchase (from before the pool became revenue-funded): − the share
//   of what it credited, clamped by PoolBank.debit; a membership payment: its
//   included credit, once per payment. A refund (or
//   dispute) of a payment not applied yet throws RetryLaterError only while
//   that payment will grant something once applied (`grantsOnPayment`); a
//   refund of one that never grants is logged (`refund_not_debited`) and
//   acknowledged, so it can't fail every delivery.
// - dispute.opened / dispute.lost → debited like a refund of the disputed
//   amount (membership disputes are left to the operator); lost also
//   suspends the buyer's pool access, once. dispute.won → what the dispute
//   took is credited back, once. A dispute that will never be debited (not
//   a purchase) gets a zero-amount `<disputeRef>:ignored` marker, so the
//   poller neither asks the provider about it nor logs it again.
// - membership.changed → the `billing_subscriptions` snapshot, newest wins.
//
// Any event that names both our user and the provider's customer records
// them in `billing_customers`.
import { billingAccountIdFor, DEV_SIMPLE_ACCOUNT_ID, userIdOfAccount } from '../../auth/account.js';
import type { AppEnv } from '../../env.js';
import { identitySuspensionStatement } from '../../pool/identity.js';
import { poolBank } from '../../pool/ids.js';
import { creditEquivalentMicros } from '../../pool/pricing.js';
import { grantByRef, grantCredit, grantTowardCap, hasGrant, type GrantRow } from '../ledger.js';
import { membershipCreditCents } from '../membership.js';
import { centsToMicros } from '../pricing.js';
import { fulfilPurchase } from '../purchases.js';
import { rememberCustomer } from './customers.js';
import { paymentProvider } from './index.js';
import type {
  DisputeEvent,
  MembershipChanged,
  PaymentEvent,
  PaymentFacts,
  PaymentProvider,
  PaymentSucceeded,
  ProviderRef,
  RefundSucceeded,
} from './port.js';
import { membershipRefundRef, reinstatedRef } from './refs.js';

/** The note on the credit a membership payment includes (and that a refund of it takes back). */
export const MEMBERSHIP_CREDIT_NOTE = 'Included with membership';
/** The `billing_subscriptions.kind` (and checkout metadata `kind`) of the yearly membership. */
export const MEMBERSHIP_KIND = 'membership';

/**
 * Thrown when the provider should deliver the event again later (a fee not
 * known yet, a refund that arrived before its payment): the webhook route
 * answers 500, and a dispute poll retries on its next run.
 */
export class RetryLaterError extends Error {
  override readonly name = 'RetryLaterError';
}

/** `applied`: something was written; `duplicate`: already done; `skipped`: nothing to do. */
export type ApplyResult = 'applied' | 'duplicate' | 'skipped';

export interface ApplyDeps {
  /** Asked about payments we hold no grant for (`getPayment`); null when payments are off. */
  provider: PaymentProvider | null;
}

function log(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, ...fields }));
}

function written(changed: boolean): ApplyResult {
  return changed ? 'applied' : 'duplicate';
}

/**
 * True when `accountId` is a user's own ledger (`u_<userId>`, or the dev
 * bypass's `default_simple`); anything else that received a purchase is a
 * open pool account (a legacy pool purchase).
 */
function isPersonalLedger(accountId: string): boolean {
  return accountId === DEV_SIMPLE_ACCOUNT_ID || userIdOfAccount(accountId) !== null;
}

/** The personal ledger a credits payment is credited to; null = never credited (`no_account`). */
function creditsAccountOf(
  purpose: { accountId: string | null },
  userId: string | null,
): string | null {
  const accountId = purpose.accountId || (userId ? billingAccountIdFor(userId) : null);
  return accountId && isPersonalLedger(accountId) ? accountId : null;
}

/** Applies one normalised payment event. Throws RetryLaterError (or a D1 error) to be retried. */
export async function applyPaymentEvent(
  env: AppEnv,
  event: PaymentEvent,
  deps: ApplyDeps = { provider: paymentProvider(env) },
): Promise<ApplyResult> {
  switch (event.type) {
    case 'payment.succeeded':
      return paymentSucceeded(env, event);
    case 'refund.succeeded':
      return refundSucceeded(env, event, deps);
    case 'dispute.opened':
    case 'dispute.lost':
      return disputeDebited(env, event, deps);
    case 'dispute.won':
      return disputeWon(env, event);
    case 'membership.changed':
      return membershipChanged(env, event);
  }
}

async function paymentSucceeded(env: AppEnv, e: PaymentSucceeded): Promise<ApplyResult> {
  if (e.userId && e.customerRef)
    await rememberCustomer(env.DB, e.provider, e.userId, e.customerRef);
  const purpose = e.purpose;
  if (purpose.kind === 'other') {
    log('payment_not_credited', { reason: 'other', paymentRef: e.paymentRef });
    return 'skipped';
  }
  if (purpose.kind === 'membership') return membershipPayment(env, e);

  if (e.currency !== 'usd') {
    log('payment_not_credited', {
      reason: 'currency',
      paymentRef: e.paymentRef,
      currency: e.currency,
    });
    return 'skipped';
  }
  if (purpose.target === 'unknown') {
    log('payment_not_credited', { reason: 'unknown_target', paymentRef: e.paymentRef });
    return 'skipped';
  }
  if (!(e.netCents > 0)) return 'skipped';
  if (await hasGrant(env.DB, e.paymentRef)) return 'duplicate';
  if (!e.fee) throw new RetryLaterError(`The fee of ${e.paymentRef} is not known yet`);
  const accountId = creditsAccountOf(purpose, e.userId);
  if (!accountId) {
    log('payment_not_credited', { reason: 'no_account', paymentRef: e.paymentRef });
    return 'skipped';
  }
  if (e.fee.estimated)
    log('fee_estimated', { paymentRef: e.paymentRef, feeCents: e.fee.cents, netCents: e.netCents });
  return written(
    await fulfilPurchase(env, {
      userId: e.userId ?? userIdOfAccount(accountId),
      accountId,
      grossCents: e.netCents,
      processorFeeCents: e.fee.cents,
      ref: e.paymentRef,
    }),
  );
}

/**
 * A paid membership year (the first or a renewal) includes
 * MEMBERSHIP_CREDIT_CENTS of credit: a fixed gift, not a purchase, so no
 * gross amount or fee. Nothing when the built-in provider isn't offered (the
 * amount is then 0) or nothing was paid (a trial or a 100% discount).
 */
async function membershipPayment(env: AppEnv, e: PaymentSucceeded): Promise<ApplyResult> {
  if (!(e.netCents > 0)) return 'skipped';
  const cents = membershipCreditCents(env);
  let credited: ApplyResult = 'skipped';
  if (cents > 0) {
    if (e.userId) {
      credited = written(
        await grantCredit(env.DB, {
          accountId: billingAccountIdFor(e.userId),
          kind: 'subscription',
          amountMicros: centsToMicros(cents),
          grossMicros: null,
          feeMicros: 0,
          userId: e.userId,
          providerRef: e.paymentRef,
          note: MEMBERSHIP_CREDIT_NOTE,
        }),
      );
    } else {
      log('payment_not_credited', { reason: 'no_user', paymentRef: e.paymentRef });
    }
  }
  return credited;
}

/**
 * True when applying this payment writes a grant (what `paidGrant` reads): a
 * credits payment `paymentSucceeded` credits on its own ref (every skip
 * there, `currency`, `unknown_target`, nothing paid and `no_account`, is
 * final), or, with `membership`, a membership payment whose included credit
 * `membershipPayment` grants (as configured now). A payment that grants
 * nothing is never waited for, so its refund can't be retried forever.
 */
function grantsOnPayment(env: AppEnv, facts: PaymentFacts, membership: boolean): boolean {
  if (!(facts.netCents > 0)) return false;
  const purpose = facts.purpose;
  if (purpose.kind === 'membership')
    return membership && !!facts.userId && membershipCreditCents(env) > 0;
  if (purpose.kind !== 'credits' || purpose.target === 'unknown' || facts.currency !== 'usd')
    return false;
  return creditsAccountOf(purpose, facts.userId) !== null;
}

/**
 * The grant a refund or dispute names. With none, asks the provider: a
 * payment that will grant once applied (`grantsOnPayment`; membership
 * payments only for a refund) means the event came first, so retry; a
 * payment that never grants anything (or one the provider doesn't know)
 * means there is nothing to take back.
 */
async function paidGrant(
  env: AppEnv,
  paymentRef: ProviderRef,
  deps: ApplyDeps,
  o: { membership: boolean },
): Promise<GrantRow | null> {
  const grant = await grantByRef(env.DB, paymentRef);
  if (grant) return grant;
  const facts = deps.provider ? await deps.provider.getPayment(paymentRef) : null;
  if (facts && grantsOnPayment(env, facts, o.membership))
    throw new RetryLaterError(`${paymentRef} is not applied yet`);
  return null;
}

async function refundSucceeded(
  env: AppEnv,
  e: RefundSucceeded,
  deps: ApplyDeps,
): Promise<ApplyResult> {
  if (e.currency !== 'usd') {
    log('refund_not_debited', { reason: 'currency', refundRef: e.refundRef, currency: e.currency });
    return 'skipped';
  }
  const result = await refundGrant(env, e, deps);
  if (result === 'skipped')
    log('refund_not_debited', {
      reason: 'nothing_granted',
      refundRef: e.refundRef,
      paymentRef: e.paymentRef,
    });
  return result;
}

async function refundGrant(env: AppEnv, e: RefundSucceeded, deps: ApplyDeps): Promise<ApplyResult> {
  const grant = await paidGrant(env, e.paymentRef, deps, { membership: true });
  if (!grant) return 'skipped';
  if (grant.kind === 'subscription') {
    // The membership's included credit is taken back once, whatever the refunded amount
    // (a fixed gift, not a share of the price), so later partial refunds add nothing.
    if (grant.amount_micros <= 0) return 'skipped';
    return written(
      await grantCredit(env.DB, {
        accountId: grant.account_id,
        kind: 'refund',
        amountMicros: -grant.amount_micros,
        userId: grant.user_id,
        providerRef: membershipRefundRef(e.paymentRef),
        note: `Refund of membership payment ${e.paymentRef}`,
      }),
    );
  }
  if (grant.kind !== 'purchase') return 'skipped';
  return debitPurchase(env, grant, {
    paymentRef: e.paymentRef,
    ref: e.refundRef,
    netCents: e.netCents,
    note: `Refund of ${e.paymentRef}`,
  });
}

/**
 * What a personal purchase's refunds and disputes may take back together:
 * the pre-tax amount paid (the fee is the buyer's to bear), or what it
 * credited for an old row without its gross amount.
 */
function personalCapMicros(grant: GrantRow): number {
  return grant.gross_micros !== null && grant.gross_micros > 0
    ? grant.gross_micros
    : grant.amount_micros;
}

/**
 * Debits a purchase being refunded or disputed: a personal purchase by the
 * refunded pre-tax amount in full (it may go negative; the processor keeps
 * its fee, so the refund passes it on), a legacy pool purchase through
 * `debitPoolPurchase` (clamped). Keyed on `ref`. All of a purchase's refunds
 * and disputes together (net of won disputes) never take back more than it
 * paid (personal) or credited (pool): each row is linked to `paymentRef`.
 */
async function debitPurchase(
  env: AppEnv,
  grant: GrantRow,
  debit: { paymentRef: ProviderRef; ref: ProviderRef; netCents: number; note: string },
): Promise<ApplyResult> {
  const micros = centsToMicros(debit.netCents);
  if (micros <= 0) return 'skipped';
  if (!isPersonalLedger(grant.account_id)) {
    const { debited } = await debitPoolPurchase(env, grant, {
      paymentRef: debit.paymentRef,
      refId: debit.ref,
      refundedGrossMicros: micros,
      note: debit.note,
    });
    return written(debited);
  }
  return written(
    await grantTowardCap(env.DB, {
      accountId: grant.account_id,
      grossMicros: -micros,
      capMicros: personalCapMicros(grant),
      paymentRef: debit.paymentRef,
      userId: grant.user_id ?? userIdOfAccount(grant.account_id),
      providerRef: debit.ref,
      note: debit.note,
    }),
  );
}

/**
 * Debits the pool for `refundedGrossMicros` (pre-tax) of a legacy pool
 * purchase being refunded or disputed: the share of what the purchase actually
 * credited (`creditEquivalentMicros`, net of its fee), or, for an old row
 * without its gross amount, at most the refunded amount; capped at what is
 * left of what the purchase credited, then clamped to what the pool has
 * available. The row is always written (PoolBank.debit), so a redelivery is
 * a no-op.
 */
async function debitPoolPurchase(
  env: AppEnv,
  grant: GrantRow,
  d: { paymentRef: ProviderRef; refId: string; refundedGrossMicros: number; note: string },
): Promise<{ debited: boolean }> {
  if (d.refundedGrossMicros <= 0) return { debited: false };
  const poolId = grant.account_id;
  const requested =
    grant.gross_micros !== null && grant.gross_micros > 0
      ? creditEquivalentMicros(d.refundedGrossMicros, {
          amountMicros: grant.amount_micros,
          grossMicros: grant.gross_micros,
        })
      : d.refundedGrossMicros;
  const result = await poolBank(env, poolId).debit({
    poolId,
    refId: d.refId,
    requestedMicros: requested,
    kind: 'refund',
    userId: grant.user_id,
    grossMicros: -d.refundedGrossMicros,
    cap: { paymentRef: d.paymentRef, maxMicros: Math.max(0, grant.amount_micros) },
    note: d.note,
  });
  return { debited: result.debited };
}

/** The ledger of zero-amount markers that belong to no account (a dispute of a payment that granted nothing). */
const NO_ACCOUNT_MARKERS = 'payment-markers';

async function disputeDebited(env: AppEnv, e: DisputeEvent, deps: ApplyDeps): Promise<ApplyResult> {
  if (e.currency !== 'usd') {
    log('dispute_not_debited', { reason: 'currency', disputeRef: e.disputeRef });
    return 'skipped';
  }
  const ignoredRef = `${e.disputeRef}:ignored`;
  if (await hasGrant(env.DB, ignoredRef)) return 'duplicate';
  const grant = await paidGrant(env, e.paymentRef, deps, { membership: false });
  if (!grant || grant.kind !== 'purchase') {
    // A membership payment (or one that granted nothing): left to the operator. Final
    // (`paidGrant` retries a payment that will grant), so recorded once, logged once.
    const first = await grantCredit(env.DB, {
      accountId: grant?.account_id ?? NO_ACCOUNT_MARKERS,
      kind: 'adjustment',
      amountMicros: 0,
      userId: grant?.user_id ?? null,
      providerRef: ignoredRef,
      note: `Dispute ${e.disputeRef} of ${e.paymentRef} not debited: not a purchase`,
    });
    if (!first) return 'duplicate';
    log('dispute_not_debited', { reason: 'not_a_purchase', disputeRef: e.disputeRef });
    return 'skipped';
  }
  const result = await debitPurchase(env, grant, {
    paymentRef: e.paymentRef,
    ref: e.disputeRef,
    netCents: e.netCents,
    note: `Dispute of ${e.paymentRef}`,
  });
  if (e.type !== 'dispute.lost') return result;
  const userId = grant.user_id ?? userIdOfAccount(grant.account_id);
  const suspended = userId ? await suspendForLostDispute(env, grant, userId, e.disputeRef) : false;
  return result === 'applied' || suspended ? 'applied' : result;
}

/**
 * A dispute of a credit purchase was lost: its buyer's open pool access
 * is suspended (on the account and its pool identity, as an admin's
 * suspension; an admin can lift it). Once per dispute: a zero-amount marker
 * row keyed `<disputeRef>:lost` records it, so a poller that keeps seeing
 * the dispute as lost never undoes an admin's lift.
 */
async function suspendForLostDispute(
  env: AppEnv,
  grant: GrantRow,
  userId: string,
  disputeRef: ProviderRef,
): Promise<boolean> {
  const first = await grantCredit(env.DB, {
    accountId: grant.account_id,
    kind: 'adjustment',
    amountMicros: 0,
    userId,
    providerRef: `${disputeRef}:lost`,
    note: `Dispute ${disputeRef} lost: pool access suspended`,
  });
  if (!first) return false;
  await suspendPoolAccess(env, userId, disputeRef);
  return true;
}

/** Suspends `userId`'s open pool access after a lost dispute (account and pool identity). */
async function suspendPoolAccess(env: AppEnv, userId: string, disputeRef: string): Promise<void> {
  const db = env.DB;
  await db.batch([
    db.prepare('UPDATE auth_users SET pool_suspended = 1 WHERE id = ?').bind(userId),
    identitySuspensionStatement(db, userId, true),
  ]);
  log('pool_suspended_dispute_lost', { userId, disputeId: disputeRef });
}

/**
 * The dispute was won and its funds reinstated, once. A personal purchase:
 * its refunds alone (capped) are what is taken back now, so this credits
 * back what the dispute took beyond them (all of it unless a refund came
 * after the dispute and found nothing left). A legacy pool purchase: exactly
 * what the dispute debited (the clamped amount). Nothing when it never
 * debited anything (a poller may first see a dispute already won).
 */
async function disputeWon(env: AppEnv, e: DisputeEvent): Promise<ApplyResult> {
  const debited = await grantByRef(env.DB, e.disputeRef);
  if (!debited) return 'skipped';
  const purchase = isPersonalLedger(debited.account_id)
    ? await grantByRef(env.DB, e.paymentRef)
    : null;
  if (purchase && debited.gross_micros !== null)
    return written(
      await grantTowardCap(env.DB, {
        accountId: debited.account_id,
        grossMicros: -debited.gross_micros,
        capMicros: personalCapMicros(purchase),
        paymentRef: e.paymentRef,
        userId: debited.user_id,
        providerRef: reinstatedRef(e.disputeRef),
        note: `Dispute ${e.disputeRef} won`,
      }),
    );
  return written(
    await grantCredit(env.DB, {
      accountId: debited.account_id,
      kind: 'refund',
      amountMicros: -debited.amount_micros,
      grossMicros: debited.gross_micros === null ? null : -debited.gross_micros,
      userId: debited.user_id,
      providerRef: reinstatedRef(e.disputeRef),
      paymentRef: e.paymentRef,
      note: `Dispute ${e.disputeRef} won`,
    }),
  );
}

/**
 * Upserts the membership snapshot, unless a newer version is already stored
 * (the same version is rewritten: deliveries of one state carry the same
 * data). Ignored for a user who no longer exists.
 */
async function membershipChanged(env: AppEnv, e: MembershipChanged): Promise<ApplyResult> {
  if (e.customerRef) await rememberCustomer(env.DB, e.provider, e.userId, e.customerRef);
  const result = await env.DB.prepare(
    `INSERT INTO billing_subscriptions
       (ref, provider, user_id, kind, status, provider_status, current_period_end,
        cancel_at_period_end, ended_at, version, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
     WHERE EXISTS (SELECT 1 FROM auth_users WHERE id = ?3)
     ON CONFLICT(ref) DO UPDATE SET
       status = excluded.status, provider_status = excluded.provider_status,
       current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end, ended_at = excluded.ended_at,
       version = excluded.version, updated_at = excluded.updated_at
     WHERE excluded.version >= billing_subscriptions.version`,
  )
    .bind(
      e.subscriptionRef,
      e.provider,
      e.userId,
      MEMBERSHIP_KIND,
      e.status,
      e.providerStatus,
      e.currentPeriodEnd,
      e.cancelAtPeriodEnd ? 1 : 0,
      e.endedAt,
      e.version,
      new Date().toISOString(),
    )
    .run();
  return written((result.meta.changes ?? 0) > 0);
}
