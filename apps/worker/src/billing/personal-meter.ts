// The Tangent credit meter (`createUsageMeter`): the user's ledger
// (`AccountContext.billingAccountId`) pays for each call.
//   1. Before the upstream call: hold the call's worst case at its model's
//      price (`creditHoldMicros`; a model without a known price is refused) at
//      the list price (`CREDIT_RATES`): a pending row inserted only
//      while the balance covers it (and, for a call a user starts, fewer than
//      USAGE_MAX_PENDING are in flight), in one statement, or, for a reply
//      reserved before its nodes were written (`UsageTag.reservationId`), that
//      row repriced and stamped dispatched. Awaited; no row, no call.
//   2. Tap `billing` (generation id, reported cost) and `usage` (tokens).
//   3. At the terminal event, settle by the metered policy (settle-policy.ts):
//      released at 0 when nothing can have been billed upstream, else the
//      reported cost; failing that, with a generation id, reconcile in the
//      background via OpenRouter; else the tokens it used at the list price,
//      or the full hold when they are unknown.
import type { GenerateRequest, ProviderErrorCode, UsagePurpose } from '@tangent/shared';
import { DomainError, PaymentRequiredError } from '@tangent/core';
import type { ModelPrice } from '../config.js';
import type { AccountContext, AppEnv } from '../env.js';
import { creditPrice } from '../pool/model-prices.js';
import { ObservedRun, type UsageMeter, type UsageMeterOptions } from './meter-run.js';
import { meteredSettlement } from './settle-policy.js';
import {
  creditHoldMicros,
  CREDIT_RATES,
  creditRefusal,
  estimatedInputTokens,
  unpricedOnCredit,
  USAGE_MAX_PENDING,
} from './service.js';
import { markDispatched, repriceReservation, reservePersonalUsage } from './usage-store.js';

/**
 * Tangent credit can't start the call: the balance can't cover its hold
 * (`payment_required`), too many are in flight (`rate_limit`), its model has
 * no price (`config`) or the price couldn't be looked up (`server`). It is
 * failed before anything is sent.
 */
export class CreditRefusedError extends Error {
  constructor(
    message: string,
    readonly code: Extract<
      ProviderErrorCode,
      'payment_required' | 'rate_limit' | 'config' | 'server'
    >,
  ) {
    super(message);
    this.name = 'CreditRefusedError';
  }
}

class PersonalRun extends ObservedRun {
  private dispatched = false;

  constructor(
    env: AppEnv,
    usageId: string,
    markupBps: number,
    feeBps: number,
    defer: (p: Promise<unknown>) => void,
    options: UsageMeterOptions,
    request: GenerateRequest,
    /** The row was reserved before the reply's nodes were written: stamp it, so no release takes it. */
    private readonly reserved: boolean,
    /** The model's list price, to price the tokens of a call that reports no cost. */
    private readonly price: ModelPrice,
  ) {
    super(env, usageId, markupBps, feeBps, defer, options, request);
  }

  override async dispatch(): Promise<boolean> {
    this.dispatched = this.reserved ? await markDispatched(this.env.DB, this.usageId) : true;
    return this.dispatched;
  }

  protected async settleRun(): Promise<void> {
    const s = meteredSettlement({
      dispatched: this.dispatched,
      upstream: this.upstream,
      costUsd: this.costUsd,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      price: this.price,
    });
    if ((s.reason === 'tokens' || s.reason === 'hold') && this.generationId !== null) {
      // OpenRouter knows the real cost; failing that, the cron settles the row.
      this.defer(this.reconcileLater(this.generationId));
      return;
    }
    await this.settleOrDefer({
      costNanos: s.costNanos ?? 0,
      reason: s.reason,
      chargeHold: s.reason === 'hold',
      // A run that never dispatched must not release a row another run has dispatched.
      requireUndispatched: !this.dispatched && s.reason === 'released',
    });
  }
}

/** Calls made for another one (a reply's summaries and title): no slot of their own. */
const RIDES_ON_A_CALL: ReadonlySet<UsagePurpose> = new Set(['summary', 'title']);

/** `defer` keeps background work alive (`ctx.waitUntil` in the DO / Worker). */
export function createUsageMeter(
  env: AppEnv,
  account: AccountContext,
  defer: (p: Promise<unknown>) => void,
  options: UsageMeterOptions = {},
): UsageMeter {
  return {
    funding: 'credit',
    async begin({ tag, providerId, model, request, maxOutputTokens }) {
      const price = await creditPrice(env, model).catch((e: unknown) => {
        // The price couldn't be looked up just now (domain errors only; others fail as metering).
        throw e instanceof DomainError ? new CreditRefusedError(e.message, 'server') : e;
      });
      if (!price) throw new CreditRefusedError(unpricedOnCredit(model).message, 'config');
      const rates = CREDIT_RATES;
      // The hold bounds the output: a request without a cap gets the provider's.
      const upstream = { ...request, maxOutputTokens: request.maxOutputTokens ?? maxOutputTokens };
      const holdMicros = creditHoldMicros(
        env,
        price,
        estimatedInputTokens(request),
        upstream.maxOutputTokens,
        rates,
      );
      const run = (usageId: string, r: typeof rates, reserved: boolean) =>
        new PersonalRun(
          env,
          usageId,
          r.markupBps,
          r.feeBps,
          defer,
          options,
          upstream,
          reserved,
          price,
        );
      if (tag?.reservationId) {
        const claimed = await repriceReservation(
          env.DB,
          tag.reservationId,
          account.billingAccountId,
          holdMicros,
          tag.nodeId,
        );
        if (claimed) return run(tag.reservationId, claimed, true);
        // Already used (a reply retried without its web search), or too dear for the balance:
        // reserved afresh below, where a refusal says which.
      }
      const usageId = crypto.randomUUID();
      const purpose = tag?.purpose ?? 'other';
      const reserved = await reservePersonalUsage(
        env.DB,
        {
          id: usageId,
          accountId: account.billingAccountId,
          treeId: tag?.treeId ?? null,
          nodeId: tag?.nodeId ?? null,
          branchId: tag?.branchId ?? null,
          userId: account.userId,
          purpose,
          providerId,
          model,
          holdMicros,
          ...rates,
          createdAt: new Date().toISOString(),
        },
        // A reply's summaries and title, and a reserved reply's retry, ride on its admission.
        tag?.reservationId || RIDES_ON_A_CALL.has(purpose) ? null : USAGE_MAX_PENDING,
      );
      if (!reserved) {
        const refusal = await creditRefusal(env, account.billingAccountId, holdMicros);
        throw new CreditRefusedError(
          refusal.message,
          refusal instanceof PaymentRequiredError ? 'payment_required' : 'rate_limit',
        );
      }
      return run(usageId, rates, false);
    },
  };
}
