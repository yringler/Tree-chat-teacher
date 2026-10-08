// The domain side of payments: what each normalised
// `PaymentEvent` does to the ledger, the open pool and the membership.
// Provider-independent: adapters (billing/providers/*) turn deliveries and
// polls into events, and this module decides. Every write is idempotent on a
// provider ref (`credit_grants.provider_ref`) or guarded by a version
// (`billing_subscriptions`), so redeliveries, duplicates and any order of
// events are safe:
//
// - payment.succeeded, credits → `fulfilPurchase` (the buyer's own credit,
//   net of the processing fee), once per payment ref. Non-USD payments and
//   payments naming no user are logged and never credited; an unknown fee
//   throws RetryLaterError.
// - payment.succeeded, membership → nothing on the ledger: the membership is
//   its subscription snapshot (membership.changed below).
// - refund.succeeded → a purchase: − the refunded pre-tax amount in full
//   (the processor keeps its fee, so the refund passes it on). A refund (or dispute) of
//   a payment not applied yet throws RetryLaterError only while that payment
//   will grant something once applied (`grantsOnPayment`); a refund of one
//   that never grants (a membership payment) is logged (`refund_not_debited`)
//   and acknowledged, so it can't fail every delivery.
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
import { userIdOfAccount } from '../../auth/account.js';
import type { AppEnv } from '../../env.js';
import { identitySuspensionStatement } from '../../pool/identity.js';
import { grantByRef, grantCredit, grantTowardCap, hasGrant, type GrantRow } from '../ledger.js';
import { centsToMicros } from '../pricing.js';
import { fulfilPurchase } from '../purchases.js';
import { rememberCustomer } from './customers.js';
import { paymentProvider } from './index.js';
import {
  MEMBERSHIP_KIND,
  type DisputeEvent,
  type MembershipChanged,
  type PaymentEvent,
  type PaymentFacts,
  type PaymentProvider,
  type PaymentSucceeded,
  type ProviderRef,
  type RefundSucceeded,
} from './port.js';
import { reinstatedRef } from './refs.js';

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
  if (purpose.kind === 'membership') return 'skipped';

  if (e.currency !== 'usd') {
    log('payment_not_credited', {
      reason: 'currency',
      paymentRef: e.paymentRef,
      currency: e.currency,
    });
    return 'skipped';
  }
  if (!(e.netCents > 0)) return 'skipped';
  if (await hasGrant(env.DB, e.paymentRef)) return 'duplicate';
  if (!e.fee) throw new RetryLaterError(`The fee of ${e.paymentRef} is not known yet`);
  if (!e.userId) {
    log('payment_not_credited', { reason: 'no_account', paymentRef: e.paymentRef });
    return 'skipped';
  }
  if (e.fee.estimated)
    log('fee_estimated', { paymentRef: e.paymentRef, feeCents: e.fee.cents, netCents: e.netCents });
  return written(
    await fulfilPurchase(env, {
      userId: e.userId,
      grossCents: e.netCents,
      processorFeeCents: e.fee.cents,
      ref: e.paymentRef,
    }),
  );
}

/**
 * True when applying this payment writes a grant (what `paidGrant` reads): a
 * credits payment `paymentSucceeded` credits on its own ref (every skip
 * there, `currency`, nothing paid and `no_account`, is final). A payment that grants nothing is never waited for, so its refund
 * can't be retried forever.
 */
function grantsOnPayment(facts: PaymentFacts): boolean {
  if (!(facts.netCents > 0)) return false;
  return facts.purpose.kind === 'credits' && facts.currency === 'usd' && facts.userId !== null;
}

/**
 * The grant a refund or dispute names. With none, asks the provider: a
 * payment that will grant once applied (`grantsOnPayment`) means the event
 * came first, so retry; a payment that never grants anything (or one the
 * provider doesn't know) means there is nothing to take back.
 */
async function paidGrant(
  env: AppEnv,
  paymentRef: ProviderRef,
  deps: ApplyDeps,
): Promise<GrantRow | null> {
  const grant = await grantByRef(env.DB, paymentRef);
  if (grant) return grant;
  const facts = deps.provider ? await deps.provider.getPayment(paymentRef) : null;
  if (facts && grantsOnPayment(facts))
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
  const grant = await paidGrant(env, e.paymentRef, deps);
  if (!grant || grant.kind !== 'purchase') return 'skipped';
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
 * Debits a purchase being refunded or disputed by the refunded pre-tax amount
 * in full (it may go negative; the processor keeps its fee, so the refund
 * passes it on). Keyed on `ref`. All of a purchase's refunds and disputes
 * together (net of won disputes) never take back more than it paid: each row
 * is linked to `paymentRef`.
 */
async function debitPurchase(
  env: AppEnv,
  grant: GrantRow,
  debit: { paymentRef: ProviderRef; ref: ProviderRef; netCents: number; note: string },
): Promise<ApplyResult> {
  const micros = centsToMicros(debit.netCents);
  if (micros <= 0) return 'skipped';
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

/** The ledger of zero-amount markers that belong to no account (a dispute of a payment that granted nothing). */
const NO_ACCOUNT_MARKERS = 'payment-markers';

async function disputeDebited(env: AppEnv, e: DisputeEvent, deps: ApplyDeps): Promise<ApplyResult> {
  if (e.currency !== 'usd') {
    log('dispute_not_debited', { reason: 'currency', disputeRef: e.disputeRef });
    return 'skipped';
  }
  const ignoredRef = `${e.disputeRef}:ignored`;
  if (await hasGrant(env.DB, ignoredRef)) return 'duplicate';
  const grant = await paidGrant(env, e.paymentRef, deps);
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
 * The dispute was won and its funds reinstated, once. The purchase's refunds
 * alone (capped) are what is taken back now, so this credits back what the
 * dispute took beyond them (all of it unless a refund came after the dispute
 * and found nothing left). Nothing when it never debited anything (a poller
 * may first see a dispute already won).
 */
async function disputeWon(env: AppEnv, e: DisputeEvent): Promise<ApplyResult> {
  const debited = await grantByRef(env.DB, e.disputeRef);
  const purchase = debited ? await grantByRef(env.DB, e.paymentRef) : null;
  if (!debited || !purchase || debited.gross_micros === null) return 'skipped';
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
