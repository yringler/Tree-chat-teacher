// The community pool's revenue share (docs/polar-migration/05-pool-framing.md,
// D1 resolved): nobody buys credit for the pool; Tangent adds
// POOL_REVENUE_SHARE_BPS (default 20%) of what it earns to it, as an operator
// expense, like a free tier. Two sources, both `contribution` grants on the
// pool's ledger, idempotent on their refs:
//
// - Membership: when a paid membership payment (first year or renewal) is
//   applied, share × (pre-tax amount − the processor's actual fee), keyed
//   `<paymentRef>:pool-share`. A refund of that payment takes back the same
//   proportion of the share (refunded pre-tax / paid pre-tax), clamped to
//   what the pool has available like every pool debit, keyed
//   `<refundRef>:pool-share`. Membership disputes are left to the operator,
//   as for the included credit.
// - Personal credit: share × the markup part of the personal charges that
//   settled in a UTC day: Σ charge × markup / (10,000 + markup), from each
//   row's own `markup_bps` (the markup only, never the purchase: a top-up
//   earns Tangent nothing until its credit is spent). Pool-funded calls carry
//   no markup and own-key calls are never metered, so neither counts. One
//   grant per completed day, keyed `pool-share:usage:YYYY-MM-DD`, written by
//   the cron (cron.ts) once the day is over, catching up on missed days (at
//   most USAGE_SHARE_CATCH_UP_DAYS back). Days with nothing to share get a
//   0 row, so each day is decided exactly once. A settled row never changes,
//   so a day's sum is final once the day has ended.
//
// Rounding: integer micro-USD, rounded down (per markup rate for a day's
// usage), so the pool never gets more than the stated share.
//
// Nothing accrues while the pool is off (`POOL_ENABLED`) or the share is 0.
import type { ProviderRef } from '../billing/payments/port.js';
import { membershipPoolShareRef, poolShareReversalRef } from '../billing/payments/refs.js';
import { grantByRef, grantCredit } from '../billing/ledger.js';
import { centsToMicros } from '../billing/pricing.js';
import { appConfig } from '../config.js';
import type { AppEnv } from '../env.js';
import { poolBank, utcDay } from './ids.js';
import { creditEquivalentMicros } from './pricing.js';

const BPS_SCALE = 10_000n;
const DAY_MS = 24 * 60 * 60_000;
/** The ref prefix of the daily usage share (never a provider ref, see billing/payments/refs.ts). */
export const USAGE_SHARE_REF_PREFIX = 'pool-share:usage:';
/** How far back the cron catches up on days it missed. */
export const USAGE_SHARE_CATCH_UP_DAYS = 31;
/** A day is shared this long after it ends, so settles already under way have landed. */
export const USAGE_SHARE_GRACE_MS = 15 * 60_000;

/** The share of the revenue, bps, while the pool is on; 0 = nothing accrues. */
export function revenueShareBps(env: AppEnv): number {
  const config = appConfig(env);
  return config.flags.poolEnabled ? config.pool.revenueShareBps : 0;
}

/** `share × (net − fee)`, in micro-USD, rounded down; the fee is capped at `netCents`. */
export function membershipShareMicros(netCents: number, feeCents: number, bps: number): number {
  const net = Math.max(0, Math.round(netCents));
  const base = centsToMicros(net - Math.min(Math.max(0, Math.round(feeCents)), net));
  return Number((BigInt(base) * BigInt(Math.max(0, Math.round(bps)))) / BPS_SCALE);
}

/**
 * Adds the pool's share of a paid membership payment, once per payment.
 * Resolves false when there is nothing to add or it was already added.
 */
export async function grantMembershipShare(
  env: AppEnv,
  p: { paymentRef: ProviderRef; netCents: number; feeCents: number },
): Promise<boolean> {
  const bps = revenueShareBps(env);
  const amount = membershipShareMicros(p.netCents, p.feeCents, bps);
  if (amount <= 0) return false;
  return grantCredit(env.DB, {
    accountId: appConfig(env).pool.accountId,
    kind: 'contribution',
    amountMicros: amount,
    grossMicros: centsToMicros(p.netCents),
    feeMicros: centsToMicros(Math.min(p.feeCents, p.netCents)),
    userId: null,
    providerRef: membershipPoolShareRef(p.paymentRef),
    note: `Revenue share: ${bps / 100}% of membership payment ${p.paymentRef} after the payment fee`,
  });
}

/**
 * A refund of a membership payment takes back the same proportion of the
 * pool's share of it (whatever POOL_REVENUE_SHARE_BPS is now), clamped to
 * what the pool has available, once per refund. False when the payment added
 * no share, or this refund was already applied.
 */
export async function reverseMembershipShare(
  env: AppEnv,
  r: { paymentRef: ProviderRef; refundRef: ProviderRef; netCents: number },
): Promise<boolean> {
  const share = await grantByRef(env.DB, membershipPoolShareRef(r.paymentRef));
  if (!share || share.kind !== 'contribution' || share.amount_micros <= 0) return false;
  const refunded = centsToMicros(r.netCents);
  if (refunded <= 0) return false;
  const requested =
    share.gross_micros !== null && share.gross_micros > 0
      ? Math.min(
          share.amount_micros,
          creditEquivalentMicros(refunded, {
            amountMicros: share.amount_micros,
            grossMicros: share.gross_micros,
          }),
        )
      : share.amount_micros;
  const result = await poolBank(env, share.account_id).debit({
    poolId: share.account_id,
    refId: poolShareReversalRef(r.refundRef),
    requestedMicros: requested,
    kind: 'contribution',
    userId: null,
    grossMicros: -refunded,
    note: `Refund ${r.refundRef} of membership payment ${r.paymentRef}: revenue share taken back`,
  });
  return result.debited;
}

/** The ref of `day`'s usage share (`YYYY-MM-DD`). */
export function usageShareRef(day: string): string {
  return `${USAGE_SHARE_REF_PREFIX}${day}`;
}

interface MarkupRow {
  markup_bps: number;
  charged: number;
}

/**
 * The markup in the personal charges settled in `[from, to)` and the pool's
 * share of it, in micro-USD, each rounded down per markup rate:
 * `Σ floor(charged × m / (10,000 + m))` and `Σ floor(charged × m × bps / ((10,000 + m) × 10,000))`.
 */
export async function usageMarkupBetween(
  db: D1Database,
  from: string,
  to: string,
  bps: number,
): Promise<{ markupMicros: number; shareMicros: number }> {
  const { results } = await db
    .prepare(
      `SELECT markup_bps, SUM(charge_micros) AS charged FROM usage_events
       WHERE funding = 'personal' AND status = 'settled'
         AND settled_at >= ?1 AND settled_at < ?2
         AND markup_bps > 0 AND charge_micros > 0
       GROUP BY markup_bps`,
    )
    .bind(from, to)
    .all<MarkupRow>();
  let markup = 0n;
  let share = 0n;
  const rate = BigInt(Math.max(0, Math.round(bps)));
  for (const row of results) {
    const m = BigInt(Math.round(Number(row.markup_bps)));
    const charged = BigInt(Math.round(Number(row.charged)));
    markup += (charged * m) / (BPS_SCALE + m);
    share += (charged * m * rate) / ((BPS_SCALE + m) * BPS_SCALE);
  }
  return { markupMicros: Number(markup), shareMicros: Number(share) };
}

export interface UsageShareResult {
  /** Days granted by this run (each `YYYY-MM-DD`, oldest first; a 0 day counts). */
  days: string[];
  /** Micro-USD added to the pool by this run. */
  addedMicros: number;
}

/** The latest day with a usage share on record, if any. */
async function lastSharedDay(db: D1Database): Promise<string | null> {
  // A range on the unique `provider_ref` index (`;` sorts right after `:`).
  const row = await db
    .prepare(
      `SELECT MAX(provider_ref) AS ref FROM credit_grants
       WHERE provider_ref >= ?1 AND provider_ref < ?2`,
    )
    .bind(USAGE_SHARE_REF_PREFIX, `${USAGE_SHARE_REF_PREFIX.slice(0, -1)};`)
    .first<{ ref: string | null }>();
  return row?.ref ? row.ref.slice(USAGE_SHARE_REF_PREFIX.length) : null;
}

/**
 * The cron job: grants the pool's share of each completed UTC day's markup
 * not yet shared, oldest first, from the day after the latest one on record
 * (at most USAGE_SHARE_CATCH_UP_DAYS back; the first run starts at
 * yesterday) through the last day that ended at least USAGE_SHARE_GRACE_MS
 * before `now`. Idempotent: each day's grant is keyed on its date.
 */
export async function accruePoolUsageShare(env: AppEnv, now: Date): Promise<UsageShareResult> {
  const result: UsageShareResult = { days: [], addedMicros: 0 };
  const bps = revenueShareBps(env);
  if (bps <= 0) return result;
  const lastDay = Date.parse(utcDay(new Date(now.getTime() - USAGE_SHARE_GRACE_MS))) - DAY_MS;
  const earliest = lastDay - (USAGE_SHARE_CATCH_UP_DAYS - 1) * DAY_MS;
  const last = await lastSharedDay(env.DB);
  const first = last === null ? lastDay : Math.max(earliest, Date.parse(last) + DAY_MS);
  const poolId = appConfig(env).pool.accountId;
  for (let day = first; day <= lastDay; day += DAY_MS) {
    const from = new Date(day).toISOString();
    const date = from.slice(0, 10);
    const { markupMicros, shareMicros } = await usageMarkupBetween(
      env.DB,
      from,
      new Date(day + DAY_MS).toISOString(),
      bps,
    );
    const granted = await grantCredit(env.DB, {
      accountId: poolId,
      kind: 'contribution',
      amountMicros: shareMicros,
      grossMicros: markupMicros,
      userId: null,
      providerRef: usageShareRef(date),
      note: `Revenue share: ${bps / 100}% of the markup on personal credit used on ${date} (UTC)`,
    });
    if (!granted) continue;
    result.days.push(date);
    result.addedMicros += shareMicros;
  }
  if (result.days.length)
    console.log(
      JSON.stringify({
        event: 'pool_usage_share',
        days: result.days,
        addedMicros: result.addedMicros,
      }),
    );
  return result;
}

/**
 * What the revenue share added to the pool since Monday 00:00 UTC and since
 * the 1st of the month (net of refunds taking it back), for `/pool`.
 */
export async function poolContributions(
  env: AppEnv,
  now: Date,
  weekStart: Date,
): Promise<{ weekMicros: number; monthMicros: number }> {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN created_at >= ?2 THEN amount_micros END), 0) AS week,
       COALESCE(SUM(CASE WHEN created_at >= ?3 THEN amount_micros END), 0) AS month
     FROM credit_grants
     WHERE account_id = ?1 AND kind = 'contribution' AND created_at >= MIN(?2, ?3)`,
  )
    .bind(appConfig(env).pool.accountId, weekStart.toISOString(), month)
    .first<{ week: number; month: number }>();
  return { weekMicros: Number(row?.week ?? 0), monthMicros: Number(row?.month ?? 0) };
}
