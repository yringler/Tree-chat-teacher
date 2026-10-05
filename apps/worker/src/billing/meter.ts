// Usage metering for the built-in provider (PLAN §2.4): a `ProviderRegistry`
// decorator that records one `usage_events` row per call on a metered
// provider. Who pays is the meter's funding:
//
// - personal (`createUsageMeter`): the user's ledger (`AccountContext.billingAccountId`).
//   1. Before the upstream call: insert a pending row holding USAGE_HOLD_MICROS
//      at the markup and OpenRouter fee in force now (awaited; no row, no call).
//   2. Tap `billing` (generation id, reported cost) and `usage` (tokens).
//   3. At the terminal event: settle inline when the cost is known; else, with a
//      generation id, reconcile in the background via OpenRouter; else (the
//      request never reached OpenRouter) settle at 0.
// - the community pool (`createPoolUsageMeter`, docs/pool/PLAN.md §1.2):
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
import type {
  GenerateRequest,
  LlmProvider,
  ProviderEvent,
  ProviderRegistry,
  ProviderUpstream,
  UsageTag,
} from '@tangent/shared';
import type { AccountContext, AppEnv } from '../env.js';
import { poolBank } from '../pool/ids.js';
import { poolReserveRequest, type PoolParams } from '../pool/params.js';
import type { PoolRefusal } from '../pool/pool-bank.js';
import { exceedsContext, inputBoundTokens, worstCaseHoldMicros } from '../pool/pricing.js';
import { poolSettlement, type PoolSettlement } from '../pool/settle-policy.js';
import { costUsdToNanos } from './pricing.js';
import { reconcileGeneration, RECONCILE_RETRY_DELAYS_MS } from './reconcile.js';
import { markupFor, openRouterFeeBps, usageHoldMicros } from './service.js';
import {
  insertPendingUsage,
  markDispatched,
  setGenerationId,
  settleUsage,
  shrinkHold,
  type Settlement,
} from './usage-store.js';

export interface UsageMeter {
  /** Records (or claims) the pending row, awaited, before the upstream call starts. */
  begin(info: {
    tag: UsageTag | undefined;
    providerId: string;
    model: string;
    request: GenerateRequest;
  }): Promise<MeterRun>;
}

export interface MeterRun {
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

/** A pool reservation was refused: the call is failed before anything is sent. */
export class PoolRefusedError extends Error {
  constructor(readonly refusal: Pick<PoolRefusal, 'reason'> & Partial<PoolRefusal>) {
    super(`The community pool refused the call (${refusal.reason})`);
    this.name = 'PoolRefusedError';
  }
}

/**
 * A pool request's input could exceed its price entry's context window, so its
 * hold would not bound its cost: the call is failed before anything is sent.
 */
export class PoolRequestTooLargeError extends Error {
  constructor(readonly inputBoundTokens: number) {
    super(`The request is too large for the community pool (${inputBoundTokens} tokens)`);
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
  protected upstream: ProviderUpstream | null = null;
  protected idWrite: Promise<void> = Promise.resolve();
  private finished = false;

  constructor(
    protected readonly env: AppEnv,
    protected readonly usageId: string,
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
      } else if (event.type === 'usage') {
        const { inputTokens, outputTokens } = event.usage;
        if (typeof inputTokens === 'number' && Number.isFinite(inputTokens))
          this.inputTokens = inputTokens;
        if (typeof outputTokens === 'number' && Number.isFinite(outputTokens))
          this.outputTokens = outputTokens;
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

/** `defer` keeps background work alive (`ctx.waitUntil` in the DO / Worker). */
export function createUsageMeter(
  env: AppEnv,
  account: AccountContext,
  defer: (p: Promise<unknown>) => void,
  options: UsageMeterOptions = {},
): UsageMeter {
  return {
    async begin({ tag, providerId, model, request }) {
      const markupBps = markupFor(env);
      const feeBps = openRouterFeeBps(env);
      const usageId = crypto.randomUUID();
      await insertPendingUsage(env.DB, {
        id: usageId,
        accountId: account.billingAccountId,
        treeId: tag?.treeId ?? null,
        nodeId: tag?.nodeId ?? null,
        branchId: tag?.branchId ?? null,
        userId: account.userId,
        funding: 'personal',
        purpose: tag?.purpose ?? 'other',
        providerId,
        model,
        holdMicros: usageHoldMicros(env),
        markupBps,
        feeBps,
        createdAt: new Date().toISOString(),
      });
      return new PersonalRun(env, usageId, markupBps, feeBps, defer, options, request);
    },
  };
}

/**
 * The community pool's meter for `userId`'s calls. Holds are priced for
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
    async begin({ tag, providerId, request }) {
      const price = pool.price;
      if (!price) throw new PoolRefusedError({ reason: 'unpriced' });
      const maxOutput = Math.min(
        request.maxOutputTokens ?? pool.maxOutputTokens,
        pool.maxOutputTokens,
      );
      if (exceedsContext(price, request)) {
        const bound = inputBoundTokens(request);
        console.warn(
          JSON.stringify({
            event: 'pool_request_too_large',
            userId,
            purpose: tag?.purpose ?? 'other',
            inputBoundTokens: bound,
            contextTokens: price.contextTokens,
          }),
        );
        throw new PoolRequestTooLargeError(bound);
      }
      const holdMicros = worstCaseHoldMicros(
        price,
        request,
        maxOutput,
        price.feeBps,
        pool.markupBps,
      );
      let usageId: string;
      let feeBps = price.feeBps;
      let markupBps = pool.markupBps;
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
            markupBps,
          }),
        );
        if (!result.ok) throw new PoolRefusedError(result);
        usageId = result.usageId;
      }
      const upstream: GenerateRequest = {
        ...request,
        maxOutputTokens: maxOutput,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(pool.callTimeoutMs)]),
      };
      return new PoolRun(env, usageId, markupBps, feeBps, defer, options, upstream, pool);
    },
  };
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
    });
  } catch (e) {
    // No row, no upstream call: the provider contract is "never throw", so fail as an event.
    if (e instanceof PoolRefusedError) {
      yield {
        type: 'error',
        error: {
          code:
            e.refusal.reason === 'empty' || e.refusal.reason === 'unpriced'
              ? 'server'
              : 'rate_limit',
          message: 'The community pool cannot cover this request right now.',
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
          message: 'This conversation is too long for the community pool.',
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
    for await (const event of provider.stream(run.request)) {
      run.observe(event);
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
  const count = provider.countTokens?.bind(provider);
  if (count) wrapped.countTokens = count;
  return wrapped;
}

/**
 * Wraps `get(id).stream(req)` with the meter for the providers `metered`
 * accepts (the built-in one, see `isMetered`); the others pass through.
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
