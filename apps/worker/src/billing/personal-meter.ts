// The Tangent credit meter (`createUsageMeter`): the user's ledger
// (`AccountContext.billingAccountId`) pays for each call.
//   1. Before the upstream call: hold the call's worst case at its model's
//      price (`creditHoldMicros`; a model without a known price is refused) at
//      the list price (`CREDIT_RATES`): a pending row inserted only
//      while the balance covers it (and, for a call a user starts, fewer than
//      USAGE_MAX_PENDING are in flight), in one statement, or, for a reply
//      reserved before its nodes were written (`UsageTag.reservationId`), that
//      row repriced. Either records the input estimate the hold was sized
//      with, and is stamped dispatched right before the call goes upstream,
//      so the cron can charge that input if this meter dies. Awaited; no row
//      (or no stamp), no call.
//   2. Tap `billing` (generation id, reported cost) and `usage` (tokens).
//   3. At the terminal event, settle by the metered policy (settle-policy.ts):
//      released at 0 when nothing can have been billed upstream, else the
//      reported cost; failing that, with a generation id, reconcile in the
//      background via OpenRouter; else the tokens it used at the list price;
//      else, when the user stopped it, its estimated input at the input price;
//      else the full hold.
import type { GenerateRequest, ProviderErrorCode, UsagePurpose } from '@tangent/shared';
import { DomainError, PaymentRequiredError } from '@tangent/core';
import type { ModelPrice } from '../config.js';
import type { AccountContext, AppEnv } from '../env.js';
import { usageBackend } from '../hosted/registry.js';
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
    /** The model's list price, to price the tokens of a call that reports no cost. */
    private readonly price: ModelPrice,
    /** The estimated input tokens its hold was sized with. */
    private readonly heldInputTokens: number,
    /** Each search's fee where the provider bills it outside a reported cost. */
    private readonly searchFeeMicros: number,
  ) {
    super(env, usageId, markupBps, feeBps, defer, options, request);
  }

  override async dispatch(): Promise<boolean> {
    // Stamped, so no release takes a reserved reply's row and the cron knows the call was sent.
    this.dispatched = await markDispatched(this.env.DB, this.usageId);
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
      userStopped: this.userStopped,
      heldInputTokens: this.heldInputTokens,
      webSearches: this.webSearches,
      searchFeeMicros: this.searchFeeMicros,
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
    async begin({ tag, providerId, model, request, maxOutputTokens, searchFeeMicros }) {
      const price = await creditPrice(env, model).catch((e: unknown) => {
        // The price couldn't be looked up just now (domain errors only; others fail as metering).
        throw e instanceof DomainError ? new CreditRefusedError(e.message, 'server') : e;
      });
      if (!price) throw new CreditRefusedError(unpricedOnCredit(model).message, 'config');
      const rates = CREDIT_RATES;
      // The hold bounds the output: a request without a cap gets the provider's.
      const upstream = { ...request, maxOutputTokens: request.maxOutputTokens ?? maxOutputTokens };
      const inputTokens = estimatedInputTokens(request);
      const searchFeesMicros = (request.webSearch?.maxUses ?? 0) * searchFeeMicros;
      const holdMicros = creditHoldMicros(
        env,
        price,
        inputTokens,
        upstream.maxOutputTokens,
        rates,
        searchFeesMicros,
      );
      const run = (usageId: string, r: typeof rates) =>
        new PersonalRun(
          env,
          usageId,
          r.markupBps,
          r.feeBps,
          defer,
          options,
          upstream,
          price,
          inputTokens,
          searchFeeMicros,
        );
      if (tag?.reservationId) {
        const claimed = await repriceReservation(
          env.DB,
          tag.reservationId,
          account.billingAccountId,
          holdMicros,
          tag.nodeId,
          inputTokens,
        );
        if (claimed) return run(tag.reservationId, claimed);
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
          ...usageBackend(env, model),
          holdMicros,
          heldInputTokens: inputTokens,
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
      return run(usageId, rates);
    },
  };
}
