// What both fundings' meter runs share (billing/meter.ts wraps the stream
// around them): the `UsageMeter` and `MeterRun` contracts, and `ObservedRun`,
// which taps the stream for the generation id, the reported cost and the
// tokens, follows the call onto the next backend when it falls back, and
// settles the call's `usage_events` row.
import type { GenerateRequest, ProviderEvent, ProviderUpstream, UsageTag } from '@tangent/shared';
import type { AppEnv } from '../env.js';
import type { UsageBackend } from '../hosted/registry.js';
import { reconcileGeneration, RECONCILE_RETRY_DELAYS_MS } from './reconcile.js';
import {
  repointUsage,
  setGenerationId,
  settleUsage,
  type MeteredPayer,
  type Settlement,
} from './usage-store.js';
import { logEvent } from '../log.js';

export interface UsageMeter {
  /** Who pays: the user's credit or the open pool (logged with each call). */
  readonly funding: MeteredPayer;
  /** Records (or claims) the pending row, awaited, before the upstream call starts. */
  begin(info: {
    tag: UsageTag | undefined;
    providerId: string;
    model: string;
    request: GenerateRequest;
    /** The provider's output cap for `model`: the call's when the request sets none. */
    maxOutputTokens: number;
    /**
     * The backends the call may run on, first choice first: it is sent on the
     * first, so its row records that one (a reservation is pointed at it),
     * and its hold covers any of them.
     */
    legs: readonly MeterLeg[];
  }): Promise<MeterRun>;
}

/** What the meter knows of one backend a call may run on. */
export interface MeterLeg extends UsageBackend {
  /** The fee of each search it bills outside a reported cost (0 = none). */
  searchFeeMicros: number;
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
  /**
   * Moves the dispatched call on to `leg`, after the backend it was sent to
   * refused it before anything was billed: the row is pointed at `leg`, with
   * its fee, and what the stream showed is forgotten. False = don't send it
   * there (the row is no longer pending, or its hold can't cover `leg`).
   */
  switchTo(leg: MeterLeg): Promise<boolean>;
  /**
   * Settles inline when the cost is known, else defers reconciliation.
   * `consumerStopped`: the stream's reader stopped before its terminal event.
   */
  finish(stop?: { consumerStopped: boolean }): Promise<void>;
}

/** Test seams; production uses the defaults. */
export interface UsageMeterOptions {
  /** Backoff before each OpenRouter generation lookup (default 1, 3, 10, 30 s). */
  retryDelaysMs?: readonly number[];
  fetchImpl?: typeof fetch;
  /** Backoff for a failed inline settle (default 1, 5, 15 s); the cron covers the rest. */
  settleRetryDelaysMs?: readonly number[];
}

const SETTLE_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** What the stream showed about the call; shared by both fundings. */
export abstract class ObservedRun implements MeterRun {
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
  /** Characters of reply text streamed (`delta` events). */
  private streamedChars = 0;
  protected idWrite: Promise<void> = Promise.resolve();
  private finished = false;
  private consumerStopped = false;

  constructor(
    protected readonly env: AppEnv,
    readonly usageId: string,
    protected readonly markupBps: number,
    /** The fee of the backend the call is on (`switchTo` moves it). */
    protected feeBps: number,
    protected readonly defer: (p: Promise<unknown>) => void,
    protected readonly options: UsageMeterOptions,
    readonly request: GenerateRequest,
    /** The caller's signal: aborted when the user stopped the call (not by a timeout of the meter's own). */
    private readonly callerSignal: AbortSignal = request.signal,
  ) {}

  /** The user stopped the call: aborted it, or stopped reading it. */
  protected get userStopped(): boolean {
    return this.consumerStopped || this.callerSignal.aborted;
  }

  /**
   * The streamed characters a stopped call's output is estimated from; null
   * once there is a generation id, whose lookup gives the real cost instead.
   */
  protected get estimableOutputChars(): number | null {
    return this.generationId === null ? this.streamedChars : null;
  }

  dispatch(): Promise<boolean> {
    return Promise.resolve(true);
  }

  observe(event: ProviderEvent): void {
    try {
      if (event.type === 'delta') {
        this.streamedChars += event.text.length;
      } else if (event.type === 'billing') {
        if (event.generationId && event.generationId !== this.generationId) {
          this.generationId = event.generationId;
          // Persisted early so the cron can reconcile even if this isolate dies mid-stream.
          const id = event.generationId;
          this.idWrite = this.idWrite
            .then(() => setGenerationId(this.env.DB, this.usageId, id))
            .catch((e: unknown) =>
              logEvent('error', 'usage_generation_id_failed', { usageId: this.usageId, error: e }),
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
      logEvent('error', 'usage_observe_failed', { error: e });
    }
  }

  async switchTo(leg: MeterLeg): Promise<boolean> {
    const feeBps = this.feeBpsOn(leg);
    if (feeBps === null) return false;
    try {
      if (!(await repointUsage(this.env.DB, this.usageId, { ...leg, feeBps }))) return false;
    } catch (e) {
      logEvent('error', 'usage_repoint_failed', { usageId: this.usageId, error: e });
      return false;
    }
    this.feeBps = feeBps;
    this.generationId = null;
    this.costUsd = null;
    this.inputTokens = null;
    this.outputTokens = null;
    this.cacheReadTokens = null;
    this.cacheWriteTokens = null;
    this.upstream = null;
    this.webSearches = null;
    this.streamedChars = 0;
    this.movedTo(leg);
    return true;
  }

  /** The fee the call is charged on `leg`, or null when its hold can't cover a call there. */
  protected abstract feeBpsOn(leg: MeterLeg): number | null;

  /** The call now runs on `leg` (its own facts, such as its search fee). */
  protected movedTo(_leg: MeterLeg): void {
    // Nothing by default.
  }

  async finish(stop?: { consumerStopped: boolean }): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.consumerStopped = stop?.consumerStopped ?? false;
    try {
      await this.settleRun();
    } catch (e) {
      logEvent('error', 'usage_finish_failed', { usageId: this.usageId, error: e });
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
      logEvent('warn', 'pool_overage', { usageId: this.usageId, reason: settlement.reason });
    }
  }

  protected async settleOrDefer(s: Omit<Settlement, 'markupBps' | 'feeBps'>): Promise<void> {
    try {
      await this.settle(s);
    } catch (e) {
      logEvent('error', 'usage_settle_failed', { usageId: this.usageId, retrying: true, error: e });
      this.defer(
        (async () => {
          for (const delay of this.options.settleRetryDelaysMs ?? SETTLE_RETRY_DELAYS_MS) {
            await sleep(delay);
            try {
              await this.settle(s);
              return;
            } catch (err) {
              logEvent('error', 'usage_settle_retry_failed', { usageId: this.usageId, error: err });
            }
          }
        })(),
      );
    }
  }
}
