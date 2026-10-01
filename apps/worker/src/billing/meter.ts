// Usage metering for simple accounts (PLAN §2.4): a `ProviderRegistry`
// decorator that records one `usage_events` row per provider call.
//
// 1. Before the upstream call: insert a pending row holding USAGE_HOLD_MICROS
//    at the markup in force now (awaited; no row, no call).
// 2. Tap `billing` (generation id, reported cost) and `usage` (tokens).
// 3. At the terminal event: settle inline when the cost is known; else, with a
//    generation id, reconcile in the background via OpenRouter; else (the
//    request never reached OpenRouter) settle at 0.
// Once the row exists nothing here throws into the chat stream: failed writes
// are retried in the background and the cron (reconcile.ts) is the backstop.
import type {
  GenerateRequest,
  LlmProvider,
  ProviderEvent,
  ProviderRegistry,
  UsageTag,
} from '@tangent/shared';
import type { AccountContext, AppEnv } from '../env.js';
import { costUsdToNanos } from './pricing.js';
import { reconcileGeneration, RECONCILE_RETRY_DELAYS_MS } from './reconcile.js';
import { markupFor, usageHoldMicros } from './service.js';
import { insertPendingUsage, setGenerationId, settleUsage } from './usage-store.js';

export interface UsageMeter {
  /** Inserts the pending row (awaited) before the upstream call starts. */
  begin(info: { tag: UsageTag | undefined; providerId: string; model: string }): Promise<MeterRun>;
}

export interface MeterRun {
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

const SETTLE_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class Run implements MeterRun {
  private generationId: string | null = null;
  private costUsd: number | null = null;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private idWrite: Promise<void> = Promise.resolve();
  private finished = false;

  constructor(
    private readonly env: AppEnv,
    private readonly usageId: string,
    private readonly markupBps: number,
    private readonly defer: (p: Promise<unknown>) => void,
    private readonly options: UsageMeterOptions,
  ) {}

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
      }
    } catch (e) {
      console.error('Usage meter observe failed', e);
    }
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    try {
      if (this.costUsd !== null) {
        await this.settleOrDefer(costUsdToNanos(this.costUsd));
      } else if (this.generationId !== null) {
        const generationId = this.generationId;
        const target = {
          usageId: this.usageId,
          markupBps: this.markupBps,
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
        };
        this.defer(
          this.idWrite.then(() =>
            reconcileGeneration(this.env, target, generationId, {
              delaysMs: this.options.retryDelaysMs ?? RECONCILE_RETRY_DELAYS_MS,
              ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
            }),
          ),
        );
      } else {
        // Never reached OpenRouter (failed before a response): nothing was billed upstream.
        await this.settleOrDefer(0);
      }
    } catch (e) {
      console.error('Usage meter finish failed', this.usageId, e);
    }
  }

  private settle(costNanos: number): Promise<boolean> {
    return settleUsage(this.env.DB, this.usageId, {
      costNanos,
      markupBps: this.markupBps,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    });
  }

  private async settleOrDefer(costNanos: number): Promise<void> {
    try {
      await this.settle(costNanos);
    } catch (e) {
      console.error('Usage settle failed; retrying in the background', this.usageId, e);
      this.defer(
        (async () => {
          for (const delay of this.options.settleRetryDelaysMs ?? SETTLE_RETRY_DELAYS_MS) {
            await sleep(delay);
            try {
              await this.settle(costNanos);
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

/** `defer` keeps background work alive (`ctx.waitUntil` in the DO / Worker). */
export function createUsageMeter(
  env: AppEnv,
  account: AccountContext,
  defer: (p: Promise<unknown>) => void,
  options: UsageMeterOptions = {},
): UsageMeter {
  return {
    async begin({ tag, providerId, model }) {
      const markupBps = await markupFor(env, account);
      const usageId = crypto.randomUUID();
      await insertPendingUsage(env.DB, {
        id: usageId,
        accountId: account.id,
        treeId: tag?.treeId ?? null,
        nodeId: tag?.nodeId ?? null,
        purpose: tag?.purpose ?? 'other',
        providerId,
        model,
        holdMicros: usageHoldMicros(env),
        markupBps,
        createdAt: new Date().toISOString(),
      });
      return new Run(env, usageId, markupBps, defer, options);
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
    });
  } catch (e) {
    // No row, no upstream call: the provider contract is "never throw", so fail as an event.
    console.error('Usage metering unavailable', e);
    yield {
      type: 'error',
      error: {
        code: 'server',
        message: 'Usage metering is unavailable; please try again shortly',
        retryable: true,
      },
    };
    return;
  }
  let finished = false;
  try {
    for await (const event of provider.stream(request)) {
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
    // The consumer stopped early, or the provider ended without a terminal event.
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

/** Wraps `get(id).stream(req)` of every provider with the meter. */
export function meteredRegistry(inner: ProviderRegistry, meter: UsageMeter): ProviderRegistry {
  const cache = new WeakMap<LlmProvider, LlmProvider>();
  return {
    get(providerId) {
      const provider = inner.get(providerId);
      if (!provider) return undefined;
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
