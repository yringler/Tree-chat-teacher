// The Tangent credit meter (`createUsageMeter`): the user's ledger
// (`AccountContext.billingAccountId`) pays for each call.
//   1. Before the upstream call: hold the call's worst case at its model's
//      price (`creditHoldMicros`; a model without a known price is refused) at
//      the markup and OpenRouter fee in force now: a pending row inserted only
//      while the balance covers it (and, for a call a user starts, fewer than
//      USAGE_MAX_PENDING are in flight), in one statement, or, for a reply
//      reserved before its nodes were written (`UsageTag.reservationId`), that
//      row repriced and stamped dispatched. Awaited; no row, no call.
//   2. Tap `billing` (generation id, reported cost) and `usage` (tokens).
//   3. At the terminal event: settle inline when the cost is known; else, with a
//      generation id, reconcile in the background via OpenRouter; else (the
//      request never reached OpenRouter) settle at 0.
import {
  type GenerateRequest,
  type ProviderErrorCode,
  type UsagePurpose,
  costUsdToNanos,
} from '@tangent/shared';
import { DomainError, PaymentRequiredError } from '@tangent/core';
import type { AccountContext, AppEnv } from '../env.js';
import { creditPrice } from '../pool/model-prices.js';
import { ObservedRun, type UsageMeter, type UsageMeterOptions } from './meter-run.js';
import {
  creditHoldMicros,
  creditRates,
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
  ) {
    super(env, usageId, markupBps, feeBps, defer, options, request);
  }

  override dispatch(): Promise<boolean> {
    return this.reserved ? markDispatched(this.env.DB, this.usageId) : Promise.resolve(true);
  }

  protected async settleRun(): Promise<void> {
    if (this.costUsd !== null) {
      await this.settleOrDefer({ costNanos: costUsdToNanos(this.costUsd), reason: 'cost' });
    } else if (this.generationId !== null) {
      this.defer(this.reconcileLater(this.generationId));
    } else {
      // Never reached OpenRouter (failed before a response): nothing was billed upstream.
      await this.settleOrDefer({ costNanos: 0, reason: 'released' });
    }
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
      const rates = creditRates(env);
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
        new PersonalRun(env, usageId, r.markupBps, r.feeBps, defer, options, upstream, reserved);
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
