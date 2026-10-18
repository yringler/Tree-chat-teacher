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
 * passes (an abort test aborts there).
 */
export function tappedRegistry(
  inner: ProviderRegistry,
  taps: Tap[],
  onEvent: (event: ProviderEvent, request: GenerateRequest) => void = () => undefined,
): ProviderRegistry {
  return {
    get(id) {
      const provider = inner.get(id);
      if (!provider) return provider;
      return decorateProvider(provider, {
        stream: (request) => tapped(provider, request, taps, onEvent),
      });
    },
    list: () => inner.list(),
    defaultProviderId: () => inner.defaultProviderId(),
  };
}

async function* tapped(
  provider: LlmProvider,
  request: GenerateRequest,
  taps: Tap[],
  onEvent: (event: ProviderEvent, request: GenerateRequest) => void,
): AsyncGenerator<ProviderEvent> {
  const price = await priceOf(request.model);
  const maxOutput = request.maxOutputTokens ?? provider.capabilities(request.model).maxOutputTokens;
  const worst =
    worstUsd(price, estimatedInputTokens(request), maxOutput) +
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
    await settleBudget(ticket, summary.billing.costUsd ?? worst);
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
