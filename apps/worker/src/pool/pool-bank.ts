// PoolBank: the open pool's bank. One Durable
// Object per pool account id. D1 is the ledger and the authority; PoolBank
// only serialises the operations that can lower the pool's available balance:
//
//   available = Σ grants − Σ settled charges − Σ pending holds ≥ 0
//
// A reservation (inserting a pending `usage_events` row) runs here, under a
// lock, one at a time, after checking the balance and the caps; so no two
// reservations can both spend the same funds. Everything that can only raise
// `available` runs anywhere without the lock: settling (a charge never
// exceeds its hold, see usage-store `settleUsage`), shrinking a hold, expiry
// (this object's alarm, and the cron) and positive grants.
//
// PoolBank reads no pool config from its own env: every cap, price and TTL
// arrives as an argument, resolved Worker-side (pool/params.ts). Its storage
// holds the expiry alarm and the parameters it runs with, the balance
// checkpoint that keeps a reservation's ledger sums to the rows since it, and
// the per-minute rate-limit counters (per user and per network). The rate
// limits fail closed: if the counters can't be read or written, the request
// is refused.
import type { PoolBlockReason, UsagePurpose } from '@tangent/shared';
import { DurableObject } from 'cloudflare:workers';
import {
  balanceStatement,
  getBalance,
  grantByRef,
  grantCredit,
  readBalance,
  type BalanceCheckpoint,
  type BalanceRow,
} from '../billing/ledger.js';
import { insertPendingUsageStatement } from '../billing/usage-store.js';
import { appConfig, type PoolCaps, type PoolRateLimits } from '../config.js';
import type { AppEnv } from '../env.js';
import {
  expirePoolReservations,
  EXPIRY_RETRY_MS,
  nextExpiryAt,
  type ExpiryResult,
} from './expiry.js';

const DAY_MS = 24 * 60 * 60_000;

/**
 * The overage breaker: while the clamped overage summed over `windowMs`
 * exceeds `maxMicros`, the pool refuses every reservation (`unpriced`).
 */
export interface PoolOverage {
  windowMs: number;
  maxMicros: number;
}
/** The rate limits' fixed window. */
const MINUTE_MS = 60_000;
/**
 * The overage breaker's sum: the pool's settled overage (charges above their
 * holds) created within `windowMs` before `now`, micro-USD. The breaker is
 * tripped while it exceeds `PoolOverage.maxMicros`; the admin pool panel
 * reads the same sum.
 */
export async function poolOverageMicros(
  db: D1Database,
  poolId: string,
  windowMs: number,
  now: Date,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(overage_micros), 0) AS overage FROM usage_events
       WHERE account_id = ? AND status = 'settled' AND created_at >= ?`,
    )
    .bind(poolId, new Date(now.getTime() - windowMs).toISOString())
    .first<{ overage: number }>();
  return Number(row?.overage ?? 0);
}

/** The overage sum is re-read at most this often (it scans a day of settled rows). */
const BREAKER_CACHE_MS = 60_000;
/** When an expiry pass left more expired rows than its batch, the alarm comes back after this. */
const REARM_SOON_MS = 1_000;
/** The cron re-verifies the checkpoint against a full ledger sum this often. */
const VERIFY_EVERY_MS = DAY_MS;

/**
 * Why a reservation was refused, in the order they are checked: `unpriced`
 * (the overage breaker is tripped), `rate` (replies only: the caller's or
 * their network's requests this minute), the caller's daily caps
 * (`cap_requests`, `cap_spend`), the network's (`cap_ip`), `empty` (the pool
 * can't cover the hold), then the pool's global ceiling (`cap_global`). The
 * caps are the same for every caller: there is no member tier.
 */
export type PoolRefusalReason = Extract<
  PoolBlockReason,
  'unpriced' | 'rate' | 'cap_requests' | 'cap_spend' | 'cap_ip' | 'cap_global' | 'empty'
>;

export interface PoolExpiryParams {
  /** Reservations older than this are expired by the alarm. */
  ttlMs: number;
  giveUpMs: number;
  /** Rows one expiry pass settles. */
  batch: number;
}

export interface PoolReserveRequest {
  poolId: string;
  userId: string;
  /** The caller's network key (pool/ids.ts `ipKey`); null = no per-network caps. */
  ipKey: string | null;
  purpose: UsagePurpose;
  treeId: string | null;
  branchId: string | null;
  nodeId: string | null;
  providerId: string;
  /** The pool model the hold was priced for. */
  model: string;
  /** Worst-case cost of the call, micro-USD. */
  holdMicros: number;
  /** Fee stored on the row and applied when it settles. */
  feeBps: number;
  caps: PoolCaps;
  /** Per-minute limits; only replies count toward them (and `admit`). */
  limits: PoolRateLimits;
  overage: PoolOverage;
  expiry: PoolExpiryParams;
  /** Tests only: the clock, in ms. */
  now?: number;
}

/** `admit`: the rate check of a request that reserves nothing itself (a context resolve). */
export interface PoolAdmitRequest {
  poolId: string;
  userId: string;
  ipKey: string | null;
  limits: PoolRateLimits;
  overage: PoolOverage;
  /** Tests only: the clock, in ms. */
  now?: number;
}

export interface PoolRefusal {
  ok: false;
  reason: PoolRefusalReason;
  /**
   * When the cap resets: the next 00:00 UTC for a daily cap, the next minute
   * for `rate`; null for `empty` and `unpriced`.
   */
  resetAt: string | null;
  /** The cap that was hit (replies or requests a minute, or micro-USD); null for `empty` and `unpriced`. */
  limit: number | null;
}

/** `debit`: an admin's negative adjustment, up to `requestedMicros`, keyed on `refId`. */
export interface PoolDebitRequest {
  poolId: string;
  /** Idempotency key: `admin:<key>`. */
  refId: string;
  /** Positive micro-USD to take; the debit is clamped to what is available. */
  requestedMicros: number;
  /** The adjustment's user, if it names one. */
  userId: string | null;
  note: string;
}

/**
 * `debited`: false when `refId` was already written (nothing changed).
 * `amountMicros`: what the row took from the pool (positive; the existing
 * row's on a replay). `shortfallMicros`: requested minus taken.
 */
export interface PoolDebitResult {
  debited: boolean;
  amountMicros: number;
  shortfallMicros: number;
}

export type PoolReserveResult = { ok: true; usageId: string } | PoolRefusal;
export type PoolAdmitResult = { ok: true } | PoolRefusal;

export interface PoolMaintainResult {
  checkpoint: BalanceCheckpoint | null;
  advanced: boolean;
  /** Full ledger sum minus the checkpointed sum, when verified this run (0 = consistent). */
  mismatchMicros: number | null;
}

export interface PoolBankStatus {
  alarm: number | null;
  checkpoint: StoredCheckpoint | null;
  expiry: StoredExpiry | null;
}

interface StoredExpiry extends PoolExpiryParams {
  poolId: string;
}

interface StoredCheckpoint extends BalanceCheckpoint {
  poolId: string;
  verifiedAt: string | null;
}

export interface DayRow {
  requests: number;
  spend: number;
}

/** A usage row's spend: its hold while pending, its charge once settled. */
const SPEND_EXPR = `(CASE WHEN status = 'pending' THEN hold_micros ELSE COALESCE(charge_micros, 0) END)`;

/** Day-to-date pool usage: replies (released ones excluded) and spend. */
const DAY_USAGE_COLUMNS = `
  COUNT(CASE WHEN purpose = 'reply' AND COALESCE(settle_reason, '') <> 'released' THEN 1 END) AS requests,
  COALESCE(SUM(${SPEND_EXPR}), 0) AS spend`;

/** 00:00 UTC of `now`'s day: the daily caps' window starts here. */
export function dayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The next 00:00 UTC after `now`: when the daily caps reset. */
export function dayResetAt(now: Date): string {
  return new Date(dayStart(now).getTime() + DAY_MS).toISOString();
}

/**
 * `userId`'s pool usage since `day` (`requests`, `spend`), together with every
 * account that held their pool identity: deleting the account and signing up
 * again doesn't reset the day. Shared by `reserve` and `GET /api/pool/me`.
 */
export function userDayUsageStatement(
  db: D1Database,
  poolId: string,
  userId: string,
  day: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${DAY_USAGE_COLUMNS} FROM usage_events
       WHERE account_id = ?1 AND created_at >= ?3 AND user_id IN (
         SELECT ?2 UNION SELECT h.user_id FROM pool_identity_holders h
           JOIN pool_identity_holders me ON me.identity = h.identity WHERE me.user_id = ?2)`,
    )
    .bind(poolId, userId, day);
}

/** The refusal of `req`, logged as one JSON line (the operator's view of who hits which limit). */
function refusal(
  req: { poolId: string; userId: string; purpose?: UsagePurpose; holdMicros?: number },
  reason: PoolRefusalReason,
  fields: { resetAt?: string | null; limit?: number | null } = {},
): PoolRefusal {
  const refused: PoolRefusal = {
    ok: false,
    reason,
    resetAt: fields.resetAt ?? null,
    limit: fields.limit ?? null,
  };
  console.log(
    JSON.stringify({
      event: 'pool_refused',
      poolId: req.poolId,
      userId: req.userId,
      purpose: req.purpose ?? 'admit',
      holdMicros: req.holdMicros ?? 0,
      ...refused,
    }),
  );
  return refused;
}

export class PoolBank extends DurableObject<AppEnv> {
  /** Serialises reservations (DO input gates don't hold across D1 I/O). */
  private lock: Promise<unknown> = Promise.resolve();
  private expiry: StoredExpiry | null = null;
  private breaker: { poolId: string; overageMicros: number; readAt: number } | null = null;
  private rateTableReady = false;
  /** Tests only (`failRateChecks`): rate checks that throw, to show they fail closed. */
  private rateFailures = 0;

  /**
   * Reserves `holdMicros` of the pool for one call, or refuses it. The pending
   * row exists before this resolves `ok`, so the caller may call upstream.
   */
  async reserve(req: PoolReserveRequest): Promise<PoolReserveResult> {
    if (!Number.isSafeInteger(req.holdMicros) || req.holdMicros <= 0)
      throw new Error('PoolBank.reserve: holdMicros must be a positive integer');
    const run = this.lock.then(() => this.reserveLocked(req));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async reserveLocked(req: PoolReserveRequest): Promise<PoolReserveResult> {
    const now = new Date(req.now ?? Date.now());
    await this.rememberExpiry(req.poolId, req.expiry);
    const db = this.env.DB;
    const day = dayStart(now).toISOString();
    const resetAt = dayResetAt(now);

    const refuse = (reason: PoolRefusalReason, limit: number | null = null): PoolRefusal =>
      refusal(req, reason, {
        resetAt: reason !== 'empty' && reason !== 'unpriced' ? resetAt : null,
        limit,
      });

    if (await this.breakerTripped(req.poolId, req.overage, now)) return refuse('unpriced');
    // Only replies count toward the per-minute limits: a reply's summaries and its title
    // ride on the reply that was admitted.
    if (req.purpose === 'reply') {
      const limited = this.takeRate(req, now);
      if (limited) return limited;
    }

    const checkpoint = await this.checkpointOf(req.poolId);
    const from = checkpoint?.at ?? '';
    const statements = [
      balanceStatement(db, req.poolId, checkpoint),
      // The pool's available balance at 00:00 UTC today (the checkpoint is never later).
      db
        .prepare(
          `SELECT ?2
             + (SELECT COALESCE(SUM(amount_micros), 0) FROM credit_grants
                WHERE account_id = ?1 AND created_at >= ?3 AND created_at < ?4)
             - (SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN hold_micros ELSE COALESCE(charge_micros, 0) END), 0)
                FROM usage_events WHERE account_id = ?1 AND created_at >= ?3 AND created_at < ?4) AS available`,
        )
        .bind(req.poolId, checkpoint?.balanceMicros ?? 0, from, day),
      // What was added to the pool since 00:00 UTC: today's funding counts toward the ceilings.
      db
        .prepare(
          `SELECT COALESCE(SUM(amount_micros), 0) AS added FROM credit_grants
           WHERE account_id = ?1 AND amount_micros > 0 AND created_at >= ?2`,
        )
        .bind(req.poolId, day),
      userDayUsageStatement(db, req.poolId, req.userId, day),
      db
        .prepare(
          `SELECT ${DAY_USAGE_COLUMNS} FROM usage_events
           WHERE account_id = ?1 AND ip_key = ?2 AND created_at >= ?3`,
        )
        .bind(req.poolId, req.ipKey ?? '', day),
      // The pool's spend today, all users together.
      db
        .prepare(
          `SELECT COALESCE(SUM(${SPEND_EXPR}), 0) AS spend FROM usage_events
           WHERE account_id = ?1 AND created_at >= ?2`,
        )
        .bind(req.poolId, day),
    ];
    const [balanceRes, morningRes, addedRes, userRes, ipRes, globalRes] =
      await db.batch<Record<string, unknown>>(statements);
    const balance = readBalance(balanceRes!.results[0] as BalanceRow | undefined);
    const available = balance.balanceMicros - balance.heldMicros;
    const morning = Number((morningRes!.results[0] as { available?: number })?.available ?? 0);
    const added = Number((addedRes!.results[0] as { added?: number })?.added ?? 0);
    const user = userRes!.results[0] as DayRow | undefined;
    const ip = ipRes!.results[0] as DayRow | undefined;
    const spent = Number((globalRes!.results[0] as { spend?: number } | undefined)?.spend ?? 0);
    const caps = req.caps.user;
    const hold = req.holdMicros;

    const reply = req.purpose === 'reply';
    if (reply && Number(user?.requests ?? 0) >= caps.requestsPerDay)
      return refuse('cap_requests', caps.requestsPerDay);
    if (Number(user?.spend ?? 0) + hold > caps.spendMicrosPerDay)
      return refuse('cap_spend', caps.spendMicrosPerDay);
    if (req.ipKey !== null) {
      const ipCaps = req.caps.ip;
      if (reply && Number(ip?.requests ?? 0) >= ipCaps.requestsPerDay)
        return refuse('cap_ip', ipCaps.requestsPerDay);
      if (Number(ip?.spend ?? 0) + hold > ipCaps.spendMicrosPerDay)
        return refuse('cap_ip', ipCaps.spendMicrosPerDay);
    }
    // An empty pool says so (the first-class empty state), rather than "busy today".
    if (available < hold) return refuse('empty');
    // One ceiling for all users together, a share of the day's base: the balance at
    // 00:00 UTC plus what was added since (so funding helps the same day).
    const g = req.caps.global;
    const base = Math.max(0, morning) + Math.max(0, added);
    const share = Math.floor((base * g.bpsOfMorningBalance) / 10_000);
    const ceiling = Math.min(g.spendMicrosPerDay, share);
    if (spent + hold > ceiling) return refuse('cap_global', ceiling);

    const usageId = crypto.randomUUID();
    await insertPendingUsageStatement(db, {
      id: usageId,
      accountId: req.poolId,
      treeId: req.treeId,
      nodeId: req.nodeId,
      branchId: req.branchId,
      userId: req.userId,
      funding: 'pool',
      ipKey: req.ipKey,
      purpose: req.purpose,
      providerId: req.providerId,
      model: req.model,
      holdMicros: hold,
      // The pool pays the call's true cost: Tangent charges its own pool no markup.
      markupBps: 0,
      feeBps: req.feeBps,
      createdAt: now.toISOString(),
    }).run();
    await this.ensureAlarmBy(Date.now() + req.expiry.ttlMs);
    return { ok: true, usageId };
  }

  /**
   * Debits the pool (a negative admin adjustment),
   * under the reservation lock: a debit lowers `available` like a
   * reservation does. The amount is clamped to what is available, so the
   * pool never goes negative, and the row is written even when the clamp
   * leaves 0: keyed on `refId`, it makes a repeat a no-op. The requested
   * amount and the shortfall go in the note; the shortfall is logged.
   */
  async debit(req: PoolDebitRequest): Promise<PoolDebitResult> {
    if (!Number.isSafeInteger(req.requestedMicros) || req.requestedMicros < 0)
      throw new Error('PoolBank.debit: requestedMicros must be a non-negative integer');
    const run = this.lock.then(() => this.debitLocked(req));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async debitLocked(req: PoolDebitRequest): Promise<PoolDebitResult> {
    const db = this.env.DB;
    const existing = await grantByRef(db, req.refId);
    if (existing)
      return { debited: false, amountMicros: -existing.amount_micros, shortfallMicros: 0 };
    const requested = req.requestedMicros;
    const balance = await getBalance(db, req.poolId, await this.checkpointOf(req.poolId));
    const available = balance.balanceMicros - balance.heldMicros;
    const amount = Math.min(requested, Math.max(available, 0));
    const shortfall = requested - amount;
    const debited = await grantCredit(db, {
      accountId: req.poolId,
      kind: 'adjustment',
      amountMicros: -amount,
      grossMicros: null,
      userId: req.userId,
      providerRef: req.refId,
      note: `${req.note} (requested=${requested};shortfall=${shortfall})`,
    });
    if (debited && shortfall > 0) {
      console.warn(
        JSON.stringify({
          event: 'pool_debit_shortfall',
          poolId: req.poolId,
          refId: req.refId,
          requestedMicros: requested,
          debitedMicros: amount,
          shortfallMicros: shortfall,
        }),
      );
    }
    if (!debited) {
      // Lost a race with another writer of the same ref (not through this lock): report its row.
      const row = await grantByRef(db, req.refId);
      return { debited: false, amountMicros: -(row?.amount_micros ?? 0), shortfallMicros: 0 };
    }
    return { debited: true, amountMicros: amount, shortfallMicros: shortfall };
  }

  /**
   * The breaker and rate check without a reservation, for `context?resolve`:
   * the summaries it generates then reserve through
   * the meter, which checks the caps and the balance. Counts toward the
   * per-minute limits like a reply.
   */
  async admit(req: PoolAdmitRequest): Promise<PoolAdmitResult> {
    const run = this.lock.then(async (): Promise<PoolAdmitResult> => {
      const now = new Date(req.now ?? Date.now());
      if (await this.breakerTripped(req.poolId, req.overage, now)) return refusal(req, 'unpriced');
      return this.takeRate(req, now) ?? { ok: true };
    });
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Tests only (`TEST_SEAMS`): the next `count` rate checks throw, as a storage failure would. */
  async failRateChecks(count: number): Promise<void> {
    this.assertTestSeams();
    this.rateFailures = count;
  }

  /** Expires stale reservations, then re-arms for the next one. Takes no lock. */
  override async alarm(): Promise<void> {
    const expiry = await this.loadExpiry();
    if (expiry) await this.runExpiry(expiry, new Date());
  }

  /** Tests only (`TEST_SEAMS`): an expiry pass at a given clock (`runDurableObjectAlarm` takes none). */
  async expire(now: number): Promise<ExpiryResult | null> {
    this.assertTestSeams();
    const expiry = await this.loadExpiry();
    return expiry ? this.runExpiry(expiry, new Date(now)) : null;
  }

  /** Tests only (`TEST_SEAMS`): the alarm and what storage holds. */
  async status(): Promise<PoolBankStatus> {
    this.assertTestSeams();
    return {
      alarm: await this.ctx.storage.getAlarm(),
      checkpoint: (await this.ctx.storage.get<StoredCheckpoint>('checkpoint')) ?? null,
      expiry: await this.loadExpiry(),
    };
  }

  /**
   * Cron: advances the balance checkpoint to `min(now − 2 × giveUpMs, 00:00
   * UTC today)` when no reservation older than that is still pending, and
   * once a day verifies it against a full ledger sum (a mismatch is logged).
   * Never under the reservation lock: it only replaces one consistent
   * checkpoint with another.
   */
  async maintain(req: {
    poolId: string;
    giveUpMs: number;
    now?: number;
  }): Promise<PoolMaintainResult> {
    const now = new Date(req.now ?? Date.now());
    const db = this.env.DB;
    let checkpoint = await this.checkpointOf(req.poolId);
    const target = new Date(
      Math.min(now.getTime() - 2 * req.giveUpMs, dayStart(now).getTime()),
    ).toISOString();
    let advanced = false;
    if (!checkpoint || checkpoint.at < target) {
      const stale = await db
        .prepare(
          `SELECT 1 AS one FROM usage_events
           WHERE account_id = ? AND status = 'pending' AND created_at < ? LIMIT 1`,
        )
        .bind(req.poolId, target)
        .first<{ one: number }>();
      if (!stale) {
        const row = await db
          .prepare(
            `SELECT ?2
               + (SELECT COALESCE(SUM(amount_micros), 0) FROM credit_grants
                  WHERE account_id = ?1 AND created_at >= ?3 AND created_at < ?4)
               - (SELECT COALESCE(SUM(charge_micros), 0) FROM usage_events
                  WHERE account_id = ?1 AND status <> 'pending' AND created_at >= ?3 AND created_at < ?4) AS balance`,
          )
          .bind(req.poolId, checkpoint?.balanceMicros ?? 0, checkpoint?.at ?? '', target)
          .first<{ balance: number }>();
        const next: StoredCheckpoint = {
          poolId: req.poolId,
          balanceMicros: Number(row?.balance ?? 0),
          at: target,
          verifiedAt: checkpoint?.verifiedAt ?? null,
        };
        await this.ctx.storage.put('checkpoint', next);
        checkpoint = next;
        advanced = true;
      }
    }

    let mismatchMicros: number | null = null;
    const stored = checkpoint
      ? ((await this.ctx.storage.get<StoredCheckpoint>('checkpoint')) ?? null)
      : null;
    if (
      stored &&
      (!stored.verifiedAt || now.getTime() - Date.parse(stored.verifiedAt) >= VERIFY_EVERY_MS)
    ) {
      // One batch, so both sums read the same snapshot (a row settling between them would differ).
      const [fullRes, sinceRes] = await db.batch<BalanceRow>([
        balanceStatement(db, req.poolId),
        balanceStatement(db, req.poolId, stored),
      ]);
      const full = readBalance(fullRes!.results[0]);
      const fromCheckpoint = readBalance(sinceRes!.results[0]);
      mismatchMicros = full.balanceMicros - fromCheckpoint.balanceMicros;
      if (mismatchMicros !== 0) {
        console.error(
          JSON.stringify({
            event: 'pool_checkpoint_mismatch',
            poolId: req.poolId,
            fullMicros: full.balanceMicros,
            checkpointedMicros: fromCheckpoint.balanceMicros,
          }),
        );
        // The ledger is the authority: drop the checkpoint, so reservations sum every row until the next advance.
        await this.ctx.storage.delete('checkpoint');
        checkpoint = null;
      } else {
        await this.ctx.storage.put('checkpoint', { ...stored, verifiedAt: now.toISOString() });
      }
    }
    return { checkpoint, advanced, mismatchMicros };
  }

  private async runExpiry(expiry: StoredExpiry, now: Date): Promise<ExpiryResult> {
    const result = await expirePoolReservations(this.env, expiry.poolId, now, expiry);
    if (result.more) {
      await this.ensureAlarmBy(Date.now() + REARM_SOON_MS);
    } else {
      const due = await nextExpiryAt(this.env, expiry.poolId, expiry.ttlMs);
      // Rows already past their TTL here are waiting on a lookup: come back in a minute.
      if (due !== null) await this.ensureAlarmBy(Math.max(due, Date.now() + EXPIRY_RETRY_MS));
    }
    return result;
  }

  /** Sets the alarm to `at` unless one is already due earlier. */
  private async ensureAlarmBy(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  private async loadExpiry(): Promise<StoredExpiry | null> {
    this.expiry ??= (await this.ctx.storage.get<StoredExpiry>('expiry')) ?? null;
    return this.expiry;
  }

  /** Keeps the latest expiry parameters for the alarm (it has no request to read them from). */
  private async rememberExpiry(poolId: string, params: PoolExpiryParams): Promise<void> {
    const current = await this.loadExpiry();
    if (
      current?.poolId === poolId &&
      current.ttlMs === params.ttlMs &&
      current.giveUpMs === params.giveUpMs &&
      current.batch === params.batch
    )
      return;
    this.expiry = { poolId, ttlMs: params.ttlMs, giveUpMs: params.giveUpMs, batch: params.batch };
    await this.ctx.storage.put('expiry', this.expiry);
  }

  private async checkpointOf(poolId: string): Promise<StoredCheckpoint | null> {
    const checkpoint = await this.ctx.storage.get<StoredCheckpoint>('checkpoint');
    return checkpoint?.poolId === poolId ? checkpoint : null;
  }

  /**
   * Counts one request against the per-minute limits of the caller and their
   * network (fixed one-minute windows in this object's SQLite storage), or
   * refuses it with `rate` when either is used up. A refused request isn't
   * counted. Runs under the lock. Fails closed: any storage error refuses.
   */
  private takeRate(
    req: {
      poolId: string;
      userId: string;
      ipKey: string | null;
      limits: PoolRateLimits;
      purpose?: UsagePurpose;
      holdMicros?: number;
    },
    now: Date,
  ): PoolRefusal | null {
    const minute = Math.floor(now.getTime() / MINUTE_MS);
    const resetAt = new Date((minute + 1) * MINUTE_MS).toISOString();
    const buckets: { key: string; limit: number }[] = [
      { key: `u:${req.userId}`, limit: req.limits.userPerMinute },
    ];
    if (req.ipKey !== null) buckets.push({ key: `ip:${req.ipKey}`, limit: req.limits.ipPerMinute });
    try {
      if (this.rateFailures > 0) {
        this.rateFailures--;
        throw new Error('Rate counters unavailable (test)');
      }
      const sql = this.ctx.storage.sql;
      if (!this.rateTableReady) {
        sql.exec(
          `CREATE TABLE IF NOT EXISTS rate_windows (
             key TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL)`,
        );
        this.rateTableReady = true;
      }
      // Older windows are over: what remains is this minute's counts.
      sql.exec('DELETE FROM rate_windows WHERE minute <> ?', minute);
      for (const b of buckets) {
        const row = sql
          .exec<{ count: number }>('SELECT count FROM rate_windows WHERE key = ?', b.key)
          .toArray()[0];
        if ((row?.count ?? 0) >= b.limit) return refusal(req, 'rate', { resetAt, limit: b.limit });
      }
      for (const b of buckets)
        sql.exec(
          `INSERT INTO rate_windows (key, minute, count) VALUES (?, ?, 1)
           ON CONFLICT(key) DO UPDATE SET count = count + 1`,
          b.key,
          minute,
        );
      return null;
    } catch (err) {
      console.error(
        JSON.stringify({ event: 'pool_rate_unavailable', poolId: req.poolId, error: String(err) }),
      );
      return refusal(req, 'rate', { resetAt });
    }
  }

  /**
   * The overage breaker: true while the pool's settled overage (charges
   * clamped to their holds) within `overage.windowMs` exceeds
   * `overage.maxMicros`, i.e. a price in the table is below what calls really
   * cost. Read at most once a minute.
   */
  private async breakerTripped(poolId: string, overage: PoolOverage, now: Date): Promise<boolean> {
    const t = now.getTime();
    const cached = this.breaker;
    if (
      !cached ||
      cached.poolId !== poolId ||
      t - cached.readAt >= BREAKER_CACHE_MS ||
      t < cached.readAt
    ) {
      const overageMicros = await poolOverageMicros(this.env.DB, poolId, overage.windowMs, now);
      this.breaker = { poolId, overageMicros, readAt: t };
      if (this.breaker.overageMicros > overage.maxMicros) {
        console.error(
          JSON.stringify({
            event: 'pool_breaker_tripped',
            poolId,
            overageMicros: this.breaker.overageMicros,
            maxMicros: overage.maxMicros,
            windowMs: overage.windowMs,
          }),
        );
      }
    }
    return this.breaker!.overageMicros > overage.maxMicros;
  }

  private assertTestSeams(): void {
    if (!appConfig(this.env).testSeams) throw new Error('Not available');
  }
}
