// The open pool's meter (`createPoolUsageMeter`):
//   1. Reserve the call's exact worst case through PoolBank (or shrink the
//      reservation the reply already holds, `UsageTag.reservationId`); a
//      refusal fails the call before anything is sent.
//   2. Stamp `dispatched_at` (awaited) right before the upstream call, which
//      runs with the pool's output cap and a timeout; a reservation too close
//      to its TTL for the call to finish first is refused instead.
//   3. Settle by the pool's policy (pool/settle-policy.ts): released at 0 when
//      nothing can have been billed, else the reported cost, a generation
//      lookup, tokens × price, or the full hold. A charge never exceeds the
//      hold; the excess is recorded as overage.
import type { GenerateRequest } from '@tangent/shared';
import type { AppEnv } from '../env.js';
import { ObservedRun, type UsageMeter, type UsageMeterOptions } from '../billing/meter-run.js';
import { markDispatched, shrinkHold } from '../billing/usage-store.js';
import { poolBank } from './ids.js';
import {
  POOL_CALL_TIMEOUT_MS,
  POOL_RESERVATION_TTL_MS,
  poolReserveRequest,
  type PoolParams,
} from './params.js';
import type { PoolRefusal } from './pool-bank.js';
import {
  exceedsInputLimit,
  inputBoundTokens,
  poolInputLimitTokens,
  worstCaseHoldMicros,
} from './pricing.js';
import { poolSettlement, type PoolSettlement } from './settle-policy.js';
import { logEvent } from '../log.js';

/** A pool reservation was refused: the call is failed before anything is sent. */
export class PoolRefusedError extends Error {
  constructor(readonly refusal: Pick<PoolRefusal, 'reason'> & Partial<PoolRefusal>) {
    super(`The open pool refused the call (${refusal.reason})`);
    this.name = 'PoolRefusedError';
  }
}

/**
 * A pool request's input could exceed the pool's input limit
 * (`poolInputLimitTokens`), so the reply's ceiling hold would not bound its
 * cost: the call is failed before anything is sent.
 */
export class PoolRequestTooLargeError extends Error {
  constructor(readonly inputBoundTokens: number) {
    super(`The request is too large for the open pool (${inputBoundTokens} tokens)`);
    this.name = 'PoolRequestTooLargeError';
  }
}

class PoolRun extends ObservedRun {
  private dispatched = false;

  constructor(
    env: AppEnv,
    usageId: string,
    markupBps: number,
    feeBps: number,
    defer: (p: Promise<unknown>) => void,
    options: UsageMeterOptions,
    request: GenerateRequest,
    private readonly pool: PoolParams,
  ) {
    super(env, usageId, markupBps, feeBps, defer, options, request);
  }

  override async dispatch(): Promise<boolean> {
    // Never start a call that could still be running when the expiry alarm
    // reaches its reservation: the stamp needs POOL_CALL_TIMEOUT_MS before the TTL.
    const now = new Date();
    const notBefore = new Date(now.getTime() - (POOL_RESERVATION_TTL_MS - POOL_CALL_TIMEOUT_MS));
    this.dispatched = await markDispatched(this.env.DB, this.usageId, now, notBefore);
    return this.dispatched;
  }

  private settlement(generationCostUsd: number | null = null): PoolSettlement {
    return poolSettlement({
      dispatched: this.dispatched,
      upstream: this.upstream,
      costUsd: this.costUsd,
      generationCostUsd,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      price: this.pool.price,
    });
  }

  private apply(s: PoolSettlement): Promise<void> {
    return this.settleOrDefer({
      costNanos: s.costNanos ?? 0,
      reason: s.reason,
      chargeHold: s.reason === 'hold',
      // A run that never dispatched must not release a row another run has dispatched,
      // which may have been billed upstream; left unchanged, the row waits for that run's meter or expiry.
      requireUndispatched: !this.dispatched && s.reason === 'released',
    });
  }

  protected async settleRun(): Promise<void> {
    const s = this.settlement();
    if (s.reason === 'tokens' || s.reason === 'hold') {
      if (this.generationId !== null) {
        // OpenRouter knows the real cost; failing that, observed tokens. With neither,
        // the row waits for PoolBank's expiry (one more lookup, then the hold).
        const generationId = this.generationId;
        this.defer(
          this.reconcileLater(generationId).then(async (settled) => {
            if (!settled && s.reason === 'tokens') await this.apply(s);
          }),
        );
        return;
      }
    }
    await this.apply(s);
  }
}

/**
 * The open pool's meter for `userId`'s calls. Holds are priced for
 * `pool.model` whatever `request.model` says, output is capped at
 * `pool.maxOutputTokens`, and each call is aborted after POOL_CALL_TIMEOUT_MS.
 */
export function createPoolUsageMeter(
  env: AppEnv,
  pool: PoolParams,
  userId: string,
  defer: (p: Promise<unknown>) => void,
  options: UsageMeterOptions = {},
): UsageMeter {
  return {
    funding: 'pool',
    async begin({ tag, providerId, request }) {
      const price = pool.price;
      if (!price) throw new PoolRefusedError({ reason: 'unpriced' });
      const maxOutput = Math.min(
        request.maxOutputTokens ?? pool.maxOutputTokens,
        pool.maxOutputTokens,
      );
      const limitTokens = poolInputLimitTokens(price, pool.maxInputTokens);
      if (exceedsInputLimit(limitTokens, request)) {
        const bound = inputBoundTokens(request);
        logEvent('warn', 'pool_request_too_large', {
          userId,
          purpose: tag?.purpose ?? 'other',
          inputBoundTokens: bound,
          limitTokens,
        });
        throw new PoolRequestTooLargeError(bound);
      }
      const holdMicros = worstCaseHoldMicros(price, request, maxOutput, price.feeBps);
      let usageId: string;
      let feeBps = price.feeBps;
      if (tag?.reservationId) {
        // The reply was reserved at its ceiling before the prompt existed: shrink, never re-reserve.
        const shrunk = await shrinkHold(env.DB, tag.reservationId, pool.accountId, holdMicros);
        if (!shrunk) throw new Error(`Pool reservation ${tag.reservationId} is no longer pending`);
        usageId = tag.reservationId;
        feeBps = shrunk.feeBps;
      } else {
        const result = await poolBank(env, pool.accountId).reserve(
          poolReserveRequest(pool, userId, {
            purpose: tag?.purpose ?? 'other',
            treeId: tag?.treeId ?? null,
            branchId: tag?.branchId ?? null,
            nodeId: tag?.nodeId ?? null,
            providerId,
            holdMicros,
            feeBps,
          }),
        );
        if (!result.ok) throw new PoolRefusedError(result);
        usageId = result.usageId;
      }
      // No web search on the pool: its hold is priced from tokens alone (docs/DEFERRED.md).
      const { webSearch: _noSearch, ...withoutSearch } = request;
      const upstream: GenerateRequest = {
        ...withoutSearch,
        maxOutputTokens: maxOutput,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(POOL_CALL_TIMEOUT_MS)]),
      };
      // The pool pays the true cost: no markup.
      return new PoolRun(env, usageId, 0, feeBps, defer, options, upstream, pool);
    },
  };
}
