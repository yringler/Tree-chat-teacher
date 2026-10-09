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
// holds the expiry alarm and the parameters it runs with (expiry.ts), the
// balance checkpoint that keeps a reservation's ledger sums to the rows since
// it (checkpoint.ts), and the per-minute rate-limit counters, per user and per
// network (rate-window.ts). The day's usage it checks the caps against is
// SQL in day-usage.ts.
import type { PoolBlockReason, UsagePurpose } from '@tangent/shared';
import { DurableObject } from 'cloudflare:workers';
import {
  balanceStatement,
  getBalance,
  grantByRef,
  grantCredit,
  readBalance,
  type BalanceRow,
} from '../billing/ledger.js';
import { insertPendingUsageStatement } from '../billing/usage-store.js';
import type { PoolCaps, PoolRateLimits } from '../config.js';
import type { AppEnv } from '../env.js';
import { checkpointOf, maintainCheckpoint, type PoolMaintainResult } from './checkpoint.js';
import {
  addedSinceStatement,
  dayResetAt,
  dayStart,
  ipDayUsageStatement,
  morningBalanceStatement,
  poolDaySpendStatement,
  poolOverageMicros,
  userDayUsageStatement,
  type DayRow,
} from './day-usage.js';
import { ensureAlarmBy, runExpiry, storedExpiry, type StoredExpiry } from './expiry.js';
import { RateWindow } from './rate-window.js';
import { logEvent } from '../log.js';

/**
 * The overage breaker: while the clamped overage summed over `windowMs`
 * exceeds `maxMicros`, the pool refuses every reservation (`unpriced`).
 */
export interface PoolOverage {
  windowMs: number;
  maxMicros: number;
}
/** The overage sum is re-read at most this often (it scans a day of settled rows). */
const BREAKER_CACHE_MS = 60_000;

/**
 * Why a reservation was refused, in the order they are checked: `unpriced`
 * (the overage breaker is tripped), `rate` (replies only: the caller's or
 * their network's requests this minute), the caller's daily caps
 * (`cap_requests`, `cap_spend`), the network's (`cap_ip`), `empty` (the pool
 * can't cover the hold), then the pool's global ceiling (`cap_global`). The
 * caps are the same for every caller: there is no member tier. Last,
 * `verify`: the caller's account no longer exists (deleted while the call
 * was on its way), so no row is written for it.
 */
export type PoolRefusalReason = Extract<
  PoolBlockReason,
  'unpriced' | 'rate' | 'cap_requests' | 'cap_spend' | 'cap_ip' | 'cap_global' | 'empty' | 'verify'
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
  logEvent('info', 'pool_refused', {
    poolId: req.poolId,
    userId: req.userId,
    purpose: req.purpose ?? 'admit',
    holdMicros: req.holdMicros ?? 0,
    ...refused,
  });
  return refused;
}

export class PoolBank extends DurableObject<AppEnv> {
  /** Serialises reservations (DO input gates don't hold across D1 I/O). */
  private lock: Promise<unknown> = Promise.resolve();
  private expiry: StoredExpiry | null = null;
  private breaker: { poolId: string; overageMicros: number; readAt: number } | null = null;
  private readonly rates = new RateWindow(this.ctx.storage);

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
        resetAt:
          reason !== 'empty' && reason !== 'unpriced' && reason !== 'verify' ? resetAt : null,
        limit,
      });

    if (await this.breakerTripped(req.poolId, req.overage, now)) return refuse('unpriced');
    // Only replies count toward the per-minute limits: a reply's summaries and its title
    // ride on the reply that was admitted.
    if (req.purpose === 'reply') {
      const limited = this.takeRate(req, now);
      if (limited) return limited;
    }

    const checkpoint = await checkpointOf(this.ctx.storage, req.poolId);
    const statements = [
      balanceStatement(db, req.poolId, checkpoint),
      morningBalanceStatement(db, req.poolId, checkpoint, day),
      addedSinceStatement(db, req.poolId, day),
      userDayUsageStatement(db, req.poolId, req.userId, day),
      ipDayUsageStatement(db, req.poolId, req.ipKey, day),
      poolDaySpendStatement(db, req.poolId, day),
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
    const inserted = await insertPendingUsageStatement(db, {
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
    if (inserted.meta.changes === 0) return refuse('verify');
    await ensureAlarmBy(this.ctx.storage, Date.now() + req.expiry.ttlMs);
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
    const balance = await getBalance(
      db,
      req.poolId,
      await checkpointOf(this.ctx.storage, req.poolId),
    );
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
      logEvent('warn', 'pool_debit_shortfall', {
        poolId: req.poolId,
        refId: req.refId,
        requestedMicros: requested,
        debitedMicros: amount,
        shortfallMicros: shortfall,
      });
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

  /** Expires stale reservations, then re-arms for the next one. Takes no lock. */
  override async alarm(): Promise<void> {
    const expiry = await this.loadExpiry();
    if (expiry) await runExpiry(this.env, this.ctx.storage, expiry, new Date());
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
    return maintainCheckpoint(this.ctx.storage, this.env.DB, req);
  }

  private async loadExpiry(): Promise<StoredExpiry | null> {
    this.expiry ??= await storedExpiry(this.ctx.storage);
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

  /**
   * Counts one request against the per-minute limits of the caller and their
   * network (rate-window.ts), or refuses it with `rate` when either is used
   * up. Runs under the lock.
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
    const limited = this.rates.take(req, now);
    return limited ? refusal(req, 'rate', limited) : null;
  }

  /**
   * Account deletion: drops `userId`'s per-minute counter, so this object's
   * storage keeps no id of a deleted user. The network's counter isn't the
   * user's and stays until its minute is over.
   */
  async forgetUser(userId: string): Promise<void> {
    this.rates.forget(userId);
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
        logEvent('error', 'pool_breaker_tripped', {
          poolId,
          overageMicros: this.breaker.overageMicros,
          maxMicros: overage.maxMicros,
          windowMs: overage.windowMs,
        });
      }
    }
    return this.breaker!.overageMicros > overage.maxMicros;
  }
}
