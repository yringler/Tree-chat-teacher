// Taps on the providers production composes for the money scenarios (credit, the pool):
// under the meter, so a tap holds exactly the events the meter saw, and every call is
// budgeted like the suite's own.
import { decorateProvider } from '@tangent/providers';
import { foldStream, type StreamSummary } from '@tangent/providers/contract';
import type {
  GenerateRequest,
  LlmProvider,
  ProviderEvent,
  ProviderRegistry,
} from '@tangent/shared';
import { estimatedInputTokens } from '../../src/billing/service.js';
import type { ModelPrice } from '../../src/config.js';
import type { LegsOf } from '../../src/hosted/legs.js';
import { priceOf, reserveBudget, SEARCH_ALLOWANCE_USD, settleBudget, worstUsd } from './harness.js';

/** One provider call as the inner provider (under the meter) made it. */
export interface Tap {
  request: GenerateRequest;
  events: ProviderEvent[];
  summary: StreamSummary;
}

/**
 * `inner` with every call budgeted and recorded in `taps`: the provider under the meter,
 * so a tap holds exactly the events the meter saw. `onEvent` sees each event as it
 * passes (an abort test aborts there); `price` budgets a call (the run's price table,
 * unless a scenario prices the model in an env of its own).
 */
export function tappedRegistry(
  inner: ProviderRegistry,
  taps: Tap[],
  onEvent: (event: ProviderEvent, request: GenerateRequest) => void = () => undefined,
  price: (model: string) => Promise<ModelPrice> = priceOf,
): ProviderRegistry {
  return {
    get(id) {
      const provider = inner.get(id);
      if (!provider) return provider;
      return decorateProvider(provider, {
        stream: (request) => tapped(provider, request, taps, onEvent, price),
      });
    },
    list: () => inner.list(),
    defaultProviderId: () => inner.defaultProviderId(),
  };
}

/**
 * `legsOf` with every leg's provider tapped as `tappedRegistry` taps one: the meter
 * streams a call on its legs (hosted/legs.ts), so with more than one backend the tap
 * goes under each leg. A tap's request names the leg's model, the backend's id of it.
 */
export function tappedLegs(
  legsOf: LegsOf,
  taps: Tap[],
  price: (model: string) => Promise<ModelPrice>,
): LegsOf {
  return (provider, logical) =>
    legsOf(provider, logical).map((leg) => ({
      ...leg,
      provider: decorateProvider(leg.provider, {
        stream: (request) => tapped(leg.provider, request, taps, () => undefined, price),
      }),
    }));
}

async function* tapped(
  provider: LlmProvider,
  request: GenerateRequest,
  taps: Tap[],
  onEvent: (event: ProviderEvent, request: GenerateRequest) => void,
  priceFor: (model: string) => Promise<ModelPrice>,
): AsyncGenerator<ProviderEvent> {
  const maxOutput = request.maxOutputTokens ?? provider.capabilities(request.model).maxOutputTokens;
  const worst =
    worstUsd(await priceFor(request.model), estimatedInputTokens(request), maxOutput) +
    (request.webSearch ? SEARCH_ALLOWANCE_USD : 0);
  const ticket = await reserveBudget(worst);
  const events: ProviderEvent[] = [];
  try {
    for await (const event of provider.stream(request)) {
      events.push(event);
      onEvent(event, request);
      yield event;
    }
  } finally {
    const summary = foldStream(events);
    taps.push({ request, events, summary });
    const t = summary.terminal;
    // Refused or never sent: nothing was billed upstream.
    const unbilled =
      t?.type === 'error' && (t.error.upstream === 'rejected' || t.error.upstream === 'not_sent');
    await settleBudget(ticket, unbilled ? 0 : (summary.billing.costUsd ?? worst));
  }
}

/** Runs `work`, then every background job it deferred, and the jobs those deferred. */
export class Deferred {
  private readonly jobs: Promise<unknown>[] = [];
  readonly defer = (p: Promise<unknown>): void => {
    this.jobs.push(p);
  };
  async settle(): Promise<void> {
    while (this.jobs.length > 0) await Promise.allSettled(this.jobs.splice(0));
  }
}
