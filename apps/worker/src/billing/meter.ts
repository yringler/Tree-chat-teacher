// Usage metering for the built-in provider (PLAN §2.4): a `ProviderRegistry`
// decorator that records one `usage_events` row per call on a metered
// provider. Who pays is the meter's funding:
//
// - personal (`createUsageMeter`): the user's ledger (`AccountContext.billingAccountId`).
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
// - the open pool (`createPoolUsageMeter`, docs/pool/PLAN.md §1.2):
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
// Once the row exists nothing here throws into the chat stream: failed writes
// are retried in the background and the cron (reconcile.ts) and, for the pool,
// PoolBank's expiry alarm are the backstops.
//
// Every metered call also logs one line at its end (`event: 'llm_call'`, a
// warning when its output cap cut it off): the model, its tier, the effort
// asked for, the upstream that served it, the tokens (cached and reasoning
// shares too), the reported cost and the finish reason, so cache hit rates and
// how often a tier's cap ends replies can be read from the Worker's logs. The
// charge never comes from this line: it is the reported (or looked-up) cost,
// as above.
import {
  isLengthStop,
  type GenerateRequest,
  type LlmProvider,
  type ProviderEvent,
  type ProviderRegistry,
  type ProviderUpstream,
  type ProviderUsage,
  type UsagePurpose,
  type UsageTag,
} from '@tangent/shared';
import { PaymentRequiredError } from '@tangent/core';
import type { AccountContext, AppEnv } from '../env.js';
import { poolBank } from '../pool/ids.js';
import { creditPrice } from '../pool/model-prices.js';
import { poolReserveRequest, type PoolParams } from '../pool/params.js';
import type { PoolRefusal } from '../pool/pool-bank.js';
import {
  exceedsInputLimit,
  inputBoundTokens,
  poolInputLimitTokens,
  worstCaseHoldMicros,
} from '../pool/pricing.js';
import { poolSettlement, type PoolSettlement } from '../pool/settle-policy.js';
import { costUsdToNanos } from './pricing.js';
import { reconcileGeneration, RECONCILE_RETRY_DELAYS_MS } from './reconcile.js';
import {
  creditHoldMicros,
  creditRefusal,
  markupFor,
  openRouterFeeBps,
  unpricedOnCredit,
  usageMaxPending,
} from './service.js';
import {
  markDispatched,
  repriceReservation,
  reservePersonalUsage,
  setGenerationId,
  settleUsage,
  shrinkHold,
  type Settlement,
} from './usage-store.js';

export interface UsageMeter {
  /** Who pays: the user's credit or the open pool (logged with each call). */
  readonly funding: 'personal' | 'pool';
  /** Records (or claims) the pending row, awaited, before the upstream call starts. */
  begin(info: {
    tag: UsageTag | undefined;
    providerId: string;
    model: string;
    request: GenerateRequest;
    /** The provider's output cap for `model`: the call's when the request sets none. */
    maxOutputTokens: number;
  }): Promise<MeterRun>;
}

export interface MeterRun {
  /** The call's `usage_events` row. */
  readonly usageId: string;
  /** The request to send upstream (the pool applies its output cap and timeout). */
  readonly request: GenerateRequest;
  /** Called right before the upstream call; false = don't make it (the row is gone). */
  dispatch(): Promise<boolean>;
  /** Taps every provider event (`billing`, `usage`, ...). */
  observe(event: ProviderEvent): void;
  /** Settles inline when the cost is known, else defers reconciliation. */
  finish(): Promise<void>;
}

/** Test seams; production uses the defaults. */
export interface UsageMeterOptions {
  /** Backoff before each OpenRouter generation lookup (default 1, 3, 10, 30 s). */
  retryDelaysMs?: readonly number[];
  fetchImpl?: typeof fetch;
  /** Backoff for a failed inline settle (default 1, 5, 15 s); the cron covers the rest. */
  settleRetryDelaysMs?: readonly number[];
}

/** Tangent credit can't cover the call (or its model has no price): it is failed before anything is sent. */
export class CreditRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreditRefusedError';
  }
}

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

const SETTLE_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** What the stream showed about the call; shared by both fundings. */
abstract class ObservedRun implements MeterRun {
  protected generationId: string | null = null;
  protected costUsd: number | null = null;
  protected inputTokens: number | null = null;
  protected outputTokens: number | null = null;
  /** Of `inputTokens`, read from / written to the prompt cache (null = not reported). */
  protected cacheReadTokens: number | null = null;
  protected cacheWriteTokens: number | null = null;
  protected upstream: ProviderUpstream | null = null;
  /** Web searches seen (reported count, else 1 once a search started); null = none seen. */
  protected webSearches: number | null = null;
  protected idWrite: Promise<void> = Promise.resolve();
  private finished = false;

  constructor(
    protected readonly env: AppEnv,
    readonly usageId: string,
    protected readonly markupBps: number,
    protected readonly feeBps: number,
    protected readonly defer: (p: Promise<unknown>) => void,
    protected readonly options: UsageMeterOptions,
    readonly request: GenerateRequest,
  ) {}

  dispatch(): Promise<boolean> {
    return Promise.resolve(true);
  }

  observe(event: ProviderEvent): void {
    try {
      if (event.type === 'billing') {
        if (event.generationId && event.generationId !== this.generationId) {
          this.generationId = event.generationId;
          // Persisted early so the cron can reconcile even if this isolate dies mid-stream.
          const id = event.generationId;
          this.idWrite = this.idWrite
            .then(() => setGenerationId(this.env.DB, this.usageId, id))
            .catch((e: unknown) =>
              console.error('Recording the generation id failed', this.usageId, e),
            );
          this.defer(this.idWrite);
        }
        if (
          typeof event.costUsd === 'number' &&
          Number.isFinite(event.costUsd) &&
          event.costUsd >= 0
        ) {
          this.costUsd = event.costUsd;
        }
        if (typeof event.webSearches === 'number' && Number.isFinite(event.webSearches)) {
          this.webSearches = Math.max(0, Math.floor(event.webSearches));
        }
      } else if (event.type === 'activity' || event.type === 'citations') {
        this.webSearches ??= 1;
      } else if (event.type === 'usage') {
        const { inputTokens, outputTokens } = event.usage;
        if (typeof inputTokens === 'number' && Number.isFinite(inputTokens))
          this.inputTokens = inputTokens;
        if (typeof outputTokens === 'number' && Number.isFinite(outputTokens))
          this.outputTokens = outputTokens;
        const { cacheReadTokens, cacheWriteTokens } = event.usage;
        if (typeof cacheReadTokens === 'number' && Number.isFinite(cacheReadTokens))
          this.cacheReadTokens = cacheReadTokens;
        if (typeof cacheWriteTokens === 'number' && Number.isFinite(cacheWriteTokens))
          this.cacheWriteTokens = cacheWriteTokens;
      } else if (event.type === 'error') {
        this.upstream = event.error.upstream ?? null;
      }
    } catch (e) {
      console.error('Usage meter observe failed', e);
    }
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    try {
      await this.settleRun();
    } catch (e) {
      console.error('Usage meter finish failed', this.usageId, e);
    }
  }

  protected abstract settleRun(): Promise<void>;

  /** Background generation lookup; resolves true once settled. */
  protected reconcileLater(generationId: string): Promise<boolean> {
    const target = {
      usageId: this.usageId,
      markupBps: this.markupBps,
      feeBps: this.feeBps,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      webSearches: this.webSearches,
    };
    return this.idWrite.then(() =>
      reconcileGeneration(this.env, target, generationId, {
        delaysMs: this.options.retryDelaysMs ?? RECONCILE_RETRY_DELAYS_MS,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      }),
    );
  }

  protected async settle(s: Omit<Settlement, 'markupBps' | 'feeBps'>): Promise<void> {
    const settlement: Settlement = {
      ...s,
      markupBps: this.markupBps,
      feeBps: this.feeBps,
      inputTokens: s.inputTokens ?? this.inputTokens,
      outputTokens: s.outputTokens ?? this.outputTokens,
      webSearches: s.webSearches ?? this.webSearches,
    };
    const result = await settleUsage(this.env.DB, this.usageId, settlement);
    if (result.clamped) {
      console.warn(
        JSON.stringify({ event: 'pool_overage', usageId: this.usageId, reason: settlement.reason }),
      );
    }
  }

  protected async settleOrDefer(s: Omit<Settlement, 'markupBps' | 'feeBps'>): Promise<void> {
    try {
      await this.settle(s);
    } catch (e) {
      console.error('Usage settle failed; retrying in the background', this.usageId, e);
      this.defer(
        (async () => {
          for (const delay of this.options.settleRetryDelaysMs ?? SETTLE_RETRY_DELAYS_MS) {
            await sleep(delay);
            try {
              await this.settle(s);
              return;
            } catch (err) {
              console.error('Usage settle retry failed', this.usageId, err);
            }
          }
        })(),
      );
    }
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
    // reaches its reservation: the stamp needs `callTimeoutMs` before the TTL.
    const now = new Date();
    const notBefore = new Date(now.getTime() - (this.pool.ttlMs - this.pool.callTimeoutMs));
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
      // A run that never dispatched must not release a row another run has dispatched
      // (§1.2 step 3); left unchanged, the row waits for that run's meter or expiry.
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

/** Calls made for another one (a reply's summaries and title): no slot of their own. */
const RIDES_ON_A_CALL: ReadonlySet<UsagePurpose> = new Set(['summary', 'title', 'tagging']);

/** `defer` keeps background work alive (`ctx.waitUntil` in the DO / Worker). */
export function createUsageMeter(
  env: AppEnv,
  account: AccountContext,
  defer: (p: Promise<unknown>) => void,
  options: UsageMeterOptions = {},
): UsageMeter {
  return {
    funding: 'personal',
    async begin({ tag, providerId, model, request, maxOutputTokens }) {
      const price = await creditPrice(env, model);
      if (!price) throw new CreditRefusedError(unpricedOnCredit(model).message);
      const rates = { markupBps: markupFor(env), feeBps: openRouterFeeBps(env) };
      // The hold bounds the output: a request without a cap gets the provider's.
      const upstream = { ...request, maxOutputTokens: request.maxOutputTokens ?? maxOutputTokens };
      const holdMicros = creditHoldMicros(env, price, request, upstream.maxOutputTokens, rates);
      const run = (usageId: string, r: typeof rates, reserved: boolean) =>
        new PersonalRun(env, usageId, r.markupBps, r.feeBps, defer, options, upstream, reserved);
      if (tag?.reservationId) {
        const claimed = await repriceReservation(
          env.DB,
          tag.reservationId,
          account.billingAccountId,
          holdMicros,
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
        tag?.reservationId || RIDES_ON_A_CALL.has(purpose) ? null : usageMaxPending(env),
      );
      if (!reserved) {
        const refusal = await creditRefusal(env, account.billingAccountId, holdMicros);
        throw new CreditRefusedError(
          refusal instanceof PaymentRequiredError
            ? 'Not enough Tangent credit for this request.'
            : refusal.message,
        );
      }
      return run(usageId, rates, false);
    },
  };
}

/**
 * The open pool's meter for `userId`'s calls. Holds are priced for
 * `pool.model` whatever `request.model` says, output is capped at
 * `pool.maxOutputTokens`, and each call is aborted after `pool.callTimeoutMs`.
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
        console.warn(
          JSON.stringify({
            event: 'pool_request_too_large',
            userId,
            purpose: tag?.purpose ?? 'other',
            inputBoundTokens: bound,
            limitTokens,
          }),
        );
        throw new PoolRequestTooLargeError(bound);
      }
      const holdMicros = worstCaseHoldMicros(price, request, maxOutput, price.feeBps);
      let usageId: string;
      let feeBps = price.feeBps;
      // The pool pays the true cost (no markup); a row reserved before that keeps its own.
      let markupBps = 0;
      if (tag?.reservationId) {
        // The reply was reserved at its ceiling before the prompt existed: shrink, never re-reserve.
        const shrunk = await shrinkHold(env.DB, tag.reservationId, pool.accountId, holdMicros);
        if (!shrunk) throw new Error(`Pool reservation ${tag.reservationId} is no longer pending`);
        usageId = tag.reservationId;
        feeBps = shrunk.feeBps;
        markupBps = shrunk.markupBps;
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
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(pool.callTimeoutMs)]),
      };
      return new PoolRun(env, usageId, markupBps, feeBps, defer, options, upstream, pool);
    },
  };
}

/** What one metered call's log line reports (`event: 'llm_call'`). */
class CallLog {
  private servedBy: string | null = null;
  private costUsd: number | null = null;
  private readonly usage: Partial<ProviderUsage> = {};
  private stopReason: string | null = null;
  private error: string | null = null;

  constructor(
    private readonly provider: LlmProvider,
    private readonly request: GenerateRequest,
    private readonly funding: UsageMeter['funding'],
  ) {}

  observe(event: ProviderEvent): void {
    if (event.type === 'billing') {
      if (event.servedBy !== undefined) this.servedBy = event.servedBy;
      if (event.costUsd !== undefined) this.costUsd = event.costUsd;
    } else if (event.type === 'usage') {
      for (const [k, v] of Object.entries(event.usage) as [keyof ProviderUsage, number][])
        if (typeof v === 'number') this.usage[k] = v;
    } else if (event.type === 'done') {
      this.stopReason = event.stopReason;
    } else if (event.type === 'error') {
      this.error = event.error.code;
    }
  }

  write(usageId: string): void {
    try {
      const { request } = this;
      const listed = this.provider.models().find((m) => m.id === request.model);
      const truncated = isLengthStop(this.stopReason);
      const line = JSON.stringify({
        event: 'llm_call',
        usageId,
        funding: this.funding,
        purpose: request.usageTag?.purpose ?? 'other',
        providerId: this.provider.id,
        model: request.model,
        tier: listed?.tier ?? null,
        effort: request.reasoning ?? listed?.effort ?? null,
        providerOrder: listed?.providerOrder ?? null,
        servedBy: this.servedBy,
        maxOutputTokens: request.maxOutputTokens ?? null,
        inputTokens: this.usage.inputTokens ?? null,
        cacheReadTokens: this.usage.cacheReadTokens ?? null,
        cacheWriteTokens: this.usage.cacheWriteTokens ?? null,
        outputTokens: this.usage.outputTokens ?? null,
        reasoningTokens: this.usage.reasoningTokens ?? null,
        costUsd: this.costUsd,
        finishReason: this.stopReason,
        truncated,
        error: this.error,
      });
      if (truncated) console.warn(line);
      else console.log(line);
    } catch (e) {
      console.error('Logging the call failed', usageId, e);
    }
  }
}

async function* meteredStream(
  provider: LlmProvider,
  request: GenerateRequest,
  meter: UsageMeter,
): AsyncGenerator<ProviderEvent> {
  let run: MeterRun;
  try {
    run = await meter.begin({
      tag: request.usageTag,
      providerId: provider.id,
      model: request.model,
      request,
      maxOutputTokens: provider.capabilities(request.model).maxOutputTokens,
    });
  } catch (e) {
    // No row, no upstream call: the provider contract is "never throw", so fail as an event.
    if (e instanceof CreditRefusedError) {
      yield {
        type: 'error',
        error: { code: 'rate_limit', message: e.message, retryable: false, upstream: 'not_sent' },
      };
      return;
    }
    if (e instanceof PoolRefusedError) {
      yield {
        type: 'error',
        error: {
          code:
            e.refusal.reason === 'empty' || e.refusal.reason === 'unpriced'
              ? 'server'
              : 'rate_limit',
          message: 'The open pool cannot cover this request right now.',
          retryable: false,
          upstream: 'not_sent',
        },
      };
      return;
    }
    if (e instanceof PoolRequestTooLargeError) {
      yield {
        type: 'error',
        error: {
          code: 'context_length',
          message: 'This conversation is too long for the open pool.',
          retryable: false,
          upstream: 'not_sent',
        },
      };
      return;
    }
    console.error('Usage metering unavailable', e);
    yield {
      type: 'error',
      error: {
        code: 'server',
        message: 'Usage metering is unavailable; please try again shortly',
        retryable: true,
        upstream: 'not_sent',
      },
    };
    return;
  }
  let finished = false;
  /** Set once the call is sent upstream: only those are logged. */
  let log: CallLog | null = null;
  try {
    let dispatched = false;
    try {
      dispatched = await run.dispatch();
    } catch (e) {
      console.error('Recording the dispatch failed; not calling upstream', e);
    }
    if (!dispatched) {
      // Nothing was sent: the reservation (if it still exists) is released.
      finished = true;
      await run.finish();
      yield {
        type: 'error',
        error: {
          code: 'server',
          message: 'This request could not be started; please try again',
          retryable: true,
          upstream: 'not_sent',
        },
      };
      return;
    }
    log = new CallLog(provider, run.request, meter.funding);
    for await (const event of provider.stream(run.request)) {
      run.observe(event);
      log.observe(event);
      if (event.type === 'done' || event.type === 'error') {
        finished = true;
        await run.finish();
        yield event;
        return;
      }
      yield event;
    }
  } finally {
    // The consumer stopped early, the provider ended without a terminal event, or dispatch failed.
    if (!finished) await run.finish();
    log?.write(run.usageId);
  }
}

function meteredProvider(provider: LlmProvider, meter: UsageMeter): LlmProvider {
  const wrapped: LlmProvider = {
    get id() {
      return provider.id;
    },
    get kind() {
      return provider.kind;
    },
    get label() {
      return provider.label;
    },
    models: () => provider.models(),
    defaultModel: () => provider.defaultModel(),
    capabilities: (model) => provider.capabilities(model),
    stream: (request) => meteredStream(provider, request, meter),
  };
  const resolve = provider.resolveCapabilities?.bind(provider);
  if (resolve) wrapped.resolveCapabilities = resolve;
  const count = provider.countTokens?.bind(provider);
  if (count) wrapped.countTokens = count;
  return wrapped;
}

/**
 * Wraps `get(id).stream(req)` with the meter for the providers `metered`
 * accepts; the others pass through. The Worker (services.ts) wraps only
 * registries whose every route is paid on the operator's key, so it accepts all.
 */
export function meteredRegistry(
  inner: ProviderRegistry,
  meter: UsageMeter,
  metered: (providerId: string) => boolean,
): ProviderRegistry {
  const cache = new WeakMap<LlmProvider, LlmProvider>();
  return {
    get(providerId) {
      const provider = inner.get(providerId);
      if (!provider || !metered(providerId)) return provider;
      let wrapped = cache.get(provider);
      if (!wrapped) {
        wrapped = meteredProvider(provider, meter);
        cache.set(provider, wrapped);
      }
      return wrapped;
    },
    list: () => inner.list(),
    defaultProviderId: () => inner.defaultProviderId(),
  };
}
