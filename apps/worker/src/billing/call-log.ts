// Every metered call also logs one line at its end (`event: 'llm_call'`, a
// warning when its output cap cut it off): the model, its tier, the effort
// asked for, the upstream that served it, the tokens (cached and reasoning
// shares too), the reported cost and the finish reason, so cache hit rates and
// how often a tier's cap ends replies can be read from the Worker's logs. The
// charge never comes from this line: it is the reported (or looked-up) cost
// (meter-run.ts).
import {
  isLengthStop,
  type GenerateRequest,
  type LlmProvider,
  type ProviderEvent,
  type ProviderUsage,
} from '@tangent/shared';
import type { UsageMeter } from './meter-run.js';
import { logEvent } from '../log.js';

/** What one metered call's log line reports (`event: 'llm_call'`). */
export class CallLog {
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
      logEvent(truncated ? 'warn' : 'info', 'llm_call', {
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
    } catch (e) {
      logEvent('error', 'llm_call_log_failed', { usageId, error: e });
    }
  }
}
